// Penelope VM. Stack-based bytecode interpreter.
// State is VMState from snapshot.ts; the VM mutates it in place.

import type { Program } from './bytecode.js';
import type { VMState, Frame } from './snapshot.js';
import type { EffectEntry } from './snapshot.js';
import type { Value } from './ast.js';
import { constantToValue, formatPos } from './bytecode.js';
import { performNetFetch, performNow, performRandomInt, performReadFile, performWriteFile, categoryOf } from './effects.js';
import type { EffectName } from './effects.js';

export type RunResult =
  | { status: 'halted'; state: VMState }
  | { status: 'paused'; state: VMState };

export type ProfileData = {
  opcodeCount: Record<string, number>;
  ipCount: Record<number, number>;
  totalNs: bigint;
};

export function makeProfile(): ProfileData {
  return { opcodeCount: {}, ipCount: {}, totalNs: 0n };
}

export function freshState(): VMState {
  return {
    ip: 0,
    valueStack: [],
    frames: [{ bindings: {} }],
    effects: [],
  };
}

export function run(
  prog: Program,
  initialState?: VMState,
  profile?: ProfileData,
  tracer?: import('./tracer.js').Tracer,
): RunResult {
  const state = initialState ?? freshState();
  const t0 = profile ? process.hrtime.bigint() : 0n;
  // Resume detection: a fresh state has ip=0, empty stack, empty effects, and
  // exactly one frame (the root). Any deviation means we're resuming.
  const isResume = state.ip > 0
    || state.effects.length > 0
    || state.valueStack.length > 0
    || state.frames.length > 1
    || Object.keys(state.frames[0]?.bindings ?? {}).length > 0;
  if (tracer && isResume) {
    tracer.emit({ kind: 'resume', ip: state.ip, t: Date.now() });
  }
  try {
    const r = runUntilStop(prog, state, profile, undefined, undefined, tracer);
    if (r.status === 'breakpoint') {
      // No breakpoints passed; can't happen at runtime but narrows the type.
      throw new Error('unreachable: breakpoint without breakpoints set');
    }
    if (tracer && r.status === 'paused') {
      tracer.emit({ kind: 'pause', ip: state.ip, t: Date.now(), reason: 'pause-op' });
    }
    return r;
  } catch (e) {
    if (tracer) tracer.emit({ kind: 'error', ip: state.ip, t: Date.now(), message: (e as Error).message });
    throw e;
  } finally {
    if (profile) profile.totalNs += process.hrtime.bigint() - t0;
  }
}

// Debug stop reason for DAP — adds breakpoint variant.
export type DebugStop =
  | { status: 'halted';     state: VMState }
  | { status: 'paused';     state: VMState }
  | { status: 'breakpoint'; state: VMState; ip: number };

// Run until HALT, PAUSE, or the next ip is in `breakpoints`.
// Breakpoints are checked BEFORE executing each opcode. Skips initial ip if it's
// already in the set (so resume-from-breakpoint doesn't immediately re-trigger).
export function runUntilBreakpoint(prog: Program, state: VMState, breakpoints: Set<number>): DebugStop {
  const r = runUntilStop(prog, state, undefined, breakpoints);
  if (r.status === 'breakpoint') return r;
  return r as DebugStop;
}

export type StepMode = 'in' | 'over' | 'out';

// Execute one "logical step" then stop. Mode:
//   in:   stop after exactly one opcode (CALL descends)
//   over: stop when frames.length is back to the starting depth (skips function bodies)
//   out:  stop when frames.length drops below the starting depth (run to enclosing return)
// Also stops on HALT, PAUSE, or breakpoint.
export function runUntilStep(prog: Program, state: VMState, mode: StepMode, breakpoints?: Set<number>): DebugStop {
  const startDepth = state.frames.length;
  return runUntilStop(prog, state, undefined, breakpoints, { mode, startDepth });
}

type StepCtx = { mode: StepMode; startDepth: number };

function runUntilStop(
  prog: Program,
  state: VMState,
  profile?: ProfileData,
  breakpoints?: Set<number>,
  stepCtx?: StepCtx,
  tracer?: import('./tracer.js').Tracer,
): DebugStop {
  const replayPool = new Map<number, EffectEntry[]>();
  for (const e of state.effects) {
    if (e.status === 'committed') {
      const arr = replayPool.get(e.ip) ?? [];
      arr.push(e);
      replayPool.set(e.ip, arr);
    }
  }
  const replayIdx = new Map<number, number>();
  let firstIter = true;
  let stepIterations = 0;
  while (true) {
    if (breakpoints && !firstIter && breakpoints.has(state.ip)) {
      return { status: 'breakpoint', state, ip: state.ip };
    }
    // Stepping stop conditions (checked after firstIter so we always make progress).
    if (stepCtx && !firstIter) {
      if (stepCtx.mode === 'in' && stepIterations >= 1) {
        return { status: 'breakpoint', state, ip: state.ip };
      }
      if (stepCtx.mode === 'over' && state.frames.length <= stepCtx.startDepth && stepIterations >= 1) {
        return { status: 'breakpoint', state, ip: state.ip };
      }
      if (stepCtx.mode === 'out' && state.frames.length < stepCtx.startDepth) {
        return { status: 'breakpoint', state, ip: state.ip };
      }
    }
    firstIter = false;
    stepIterations++;
    const op = prog.code[state.ip];
    if (!op) throw new Error(`VM: IP ${state.ip} out of bounds`);
    if (profile) {
      const name = op[0];
      profile.opcodeCount[name] = (profile.opcodeCount[name] ?? 0) + 1;
      profile.ipCount[state.ip] = (profile.ipCount[state.ip] ?? 0) + 1;
    }
    switch (op[0]) {
      case 'HALT': return { status: 'halted', state };
      case 'LOAD_CONST': {
        push(state, constantToValue(prog.constants[op[1] as number]));
        state.ip++;
        break;
      }
      case 'POP':       { pop(state); state.ip++; break; }
      case 'PUSH_UNIT': { push(state, { tag: 'unit' }); state.ip++; break; }
      case 'STORE_VAR': {
        const name = op[1] as string;
        const v = pop(state);
        topFrame(state).bindings[name] = v;
        state.ip++;
        break;
      }
      case 'LOAD_VAR': {
        const name = op[1] as string;
        const ic = op[2] as { framesUp: number } | null | undefined;
        if (ic) {
          const directIdx = state.frames.length - 1 - ic.framesUp;
          if (directIdx >= 0) {
            const f = state.frames[directIdx];
            if (Object.prototype.hasOwnProperty.call(f.bindings, name)) {
              push(state, f.bindings[name]);
              state.ip++;
              break;
            }
          }
        }
        let idx = state.frames.length - 1;
        let found = false;
        while (idx >= 0) {
          const f = state.frames[idx];
          if (Object.prototype.hasOwnProperty.call(f.bindings, name)) {
            push(state, f.bindings[name]);
            found = true;
            break;
          }
          if (f.parentIdx !== undefined) idx = f.parentIdx;
          else idx--;
        }
        if (!found) throw new Error(`undefined variable '${name}' at ${formatPos(prog, state.ip)}`);
        state.ip++;
        break;
      }
      case 'BIN_OP': {
        const o = op[1] as string;
        const right = pop(state);
        const left  = pop(state);
        push(state, applyBinOp(o, left, right));
        state.ip++;
        break;
      }
      case 'JUMP': {
        state.ip = op[1] as number;
        break;
      }
      case 'JUMP_IF_FALSE': {
        const c = pop(state);
        if (c.tag !== 'bool') throw new Error(`if condition expected bool, got ${c.tag} at ${formatPos(prog, state.ip)}`);
        state.ip = !c.v ? (op[1] as number) : state.ip + 1;
        break;
      }
      case 'MAKE_CLOSURE': {
        const params = op[1] as string[];
        const bodyIp = op[2] as number;
        const bodyLen = op[3] as number;
        push(state, { tag: 'closure', params, bodyIp, bodyLen, capturedFrameIdx: state.frames.length - 1 });
        state.ip++;
        break;
      }
      case 'CALL': {
        const argc = op[1] as number;
        const args: Value[] = [];
        for (let i = 0; i < argc; i++) args.unshift(pop(state));
        const callee = pop(state);
        if (callee.tag !== 'closure') throw new Error(`call: callee is ${callee.tag}, not a function (at ${formatPos(prog, state.ip)})`);
        if (args.length !== callee.params.length) {
          throw new Error(`call: arity mismatch — expected ${callee.params.length} args, got ${args.length} (at ${formatPos(prog, state.ip)})`);
        }
        const bindings: Record<string, Value> = {};
        for (let i = 0; i < args.length; i++) bindings[callee.params[i]] = args[i];
        state.frames.push({ bindings, returnIP: state.ip + 1, parentIdx: callee.capturedFrameIdx });
        if (tracer) tracer.emit({ kind: 'fn_call', ip: state.ip, bodyIp: callee.bodyIp, argc, t: Date.now() });
        state.ip = callee.bodyIp;
        break;
      }
      case 'TAILCALL': {
        const argc = op[1] as number;
        const args: Value[] = [];
        for (let i = 0; i < argc; i++) args.unshift(pop(state));
        const callee = pop(state);
        if (callee.tag !== 'closure') throw new Error(`tailcall: callee is ${callee.tag}, not a function (at ${formatPos(prog, state.ip)})`);
        if (args.length !== callee.params.length) {
          throw new Error(`tailcall: arity mismatch — expected ${callee.params.length} args, got ${args.length} (at ${formatPos(prog, state.ip)})`);
        }
        // Find the enclosing call frame (the topmost frame with returnIP defined).
        let callFrameIdx = state.frames.length - 1;
        while (callFrameIdx >= 0 && state.frames[callFrameIdx].returnIP === undefined) callFrameIdx--;
        if (callFrameIdx < 0) {
          // No enclosing call frame (compiler bug: TAILCALL emitted at top level).
          // Degrade to a regular CALL — push a new frame.
          const bindings: Record<string, Value> = {};
          for (let i = 0; i < args.length; i++) bindings[callee.params[i]] = args[i];
          state.frames.push({ bindings, returnIP: state.ip + 1, parentIdx: callee.capturedFrameIdx });
          state.ip = callee.bodyIp;
          break;
        }
        // Safety check: if popping above the call frame would invalidate the closure's
        // captured-frame index, fall back to a regular CALL (no frame reuse). This
        // happens when a fn is defined inside its own enclosing fn's body block and
        // tail-called — the captured block frame would be popped along with the others.
        const wouldPopToIdx = callFrameIdx;
        if (callee.capturedFrameIdx > wouldPopToIdx) {
          const bindings: Record<string, Value> = {};
          for (let i = 0; i < args.length; i++) bindings[callee.params[i]] = args[i];
          state.frames.push({ bindings, returnIP: state.ip + 1, parentIdx: callee.capturedFrameIdx });
          state.ip = callee.bodyIp;
          break;
        }
        // Safe to TCO: pop block frames above the call frame, reuse it in place.
        while (state.frames.length > callFrameIdx + 1) state.frames.pop();
        const callFrame = state.frames[callFrameIdx];
        const bindings: Record<string, Value> = {};
        for (let i = 0; i < args.length; i++) bindings[callee.params[i]] = args[i];
        callFrame.bindings = bindings;
        callFrame.parentIdx = callee.capturedFrameIdx;
        // returnIP unchanged — we still return to the original caller's site.
        state.ip = callee.bodyIp;
        break;
      }
      case 'RETURN': {
        const f = state.frames.pop();
        if (!f || f.returnIP === undefined) throw new Error(`RETURN: invalid return frame`);
        if (tracer) tracer.emit({ kind: 'fn_return', ip: state.ip, t: Date.now() });
        state.ip = f.returnIP;
        break;
      }
      case 'ENTER_BLOCK': {
        state.frames.push({ bindings: {}, parentIdx: state.frames.length - 1 });
        state.ip++;
        break;
      }
      case 'EXIT_BLOCK': {
        if (state.frames.length === 1) throw new Error(`EXIT_BLOCK: cannot pop root frame`);
        state.frames.pop();
        state.ip++;
        break;
      }
      case 'EFFECT': {
        const name = op[1] as EffectName;
        const argc = op[2] as number;
        const args: Value[] = [];
        for (let i = 0; i < argc; i++) args.unshift(pop(state));
        // If a replay entry exists, this effect is being replayed (not freshly
        // executed). The tracer surfaces that distinction so audits can separate
        // first-execution effects from replay-on-resume effects.
        const isReplay = (replayPool.get(state.ip)?.length ?? 0) > (replayIdx.get(state.ip) ?? 0);
        const step = executeEffect(state, name, args, replayIdx, replayPool);
        if (tracer) tracer.emit({ kind: 'effect', ip: state.ip, name, t: Date.now(), replayed: isReplay });
        if (step.kind === 'pause') {
          // Restore args so a future resume can re-pop them.
          for (const a of args) push(state, a);
          if (tracer) tracer.emit({ kind: 'pause', ip: state.ip, t: Date.now(), reason: 'wait-effect' });
          return { status: 'paused', state };
        }
        push(state, step.v);
        state.ip++;
        break;
      }
      case 'CALL_BUILTIN': {
        const name = op[1] as string;
        const argc = op[2] as number;
        const args: Value[] = [];
        for (let i = 0; i < argc; i++) args.unshift(pop(state));
        push(state, applyBuiltin(name, args));
        state.ip++;
        break;
      }
      case 'PAUSE': {
        push(state, { tag: 'unit' });
        state.ip++;
        return { status: 'paused', state };
      }
      default:
        throw new Error(`VM: unhandled opcode '${op[0]}' at ip ${state.ip}`);
    }
  }
}

function pop(state: VMState): Value {
  const v = state.valueStack.pop();
  if (v === undefined) throw new Error(`VM: stack underflow at ip ${state.ip}`);
  return v;
}
function push(state: VMState, v: Value): void { state.valueStack.push(v); }
function topFrame(state: VMState): Frame { return state.frames[state.frames.length - 1]; }

export function applyBinOp(o: string, l: Value, r: Value): Value {
  if (o === '+') {
    if (l.tag === 'int' && r.tag === 'int') return { tag: 'int', v: l.v + r.v };
    if (l.tag === 'str' && r.tag === 'str') return { tag: 'str', v: l.v + r.v };
    throw new Error(`BIN_OP +: type mismatch ${l.tag}+${r.tag}`);
  }
  if (o === '-' || o === '*' || o === '/') {
    if (l.tag !== 'int' || r.tag !== 'int') throw new Error(`BIN_OP ${o}: ints required`);
    if (o === '-') return { tag: 'int', v: l.v - r.v };
    if (o === '*') return { tag: 'int', v: l.v * r.v };
    if (r.v === 0) throw new Error(`BIN_OP /: divide by zero`);
    return { tag: 'int', v: Math.trunc(l.v / r.v) };
  }
  if (o === '<' || o === '>' || o === '<=' || o === '>=') {
    if (l.tag !== 'int' || r.tag !== 'int') throw new Error(`BIN_OP ${o}: ints required`);
    if (o === '<')  return { tag: 'bool', v: l.v <  r.v };
    if (o === '>')  return { tag: 'bool', v: l.v >  r.v };
    if (o === '<=') return { tag: 'bool', v: l.v <= r.v };
    return { tag: 'bool', v: l.v >= r.v };
  }
  if (o === '==' || o === '!=') {
    const eq = valueEquals(l, r);
    return { tag: 'bool', v: o === '==' ? eq : !eq };
  }
  throw new Error(`BIN_OP: unknown op '${o}'`);
}

function valueEquals(a: Value, b: Value): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === 'unit') return true;
  if (a.tag === 'int'  && b.tag === 'int')  return a.v === b.v;
  if (a.tag === 'bool' && b.tag === 'bool') return a.v === b.v;
  if (a.tag === 'str'  && b.tag === 'str')  return a.v === b.v;
  if (a.tag === 'list' && b.tag === 'list') {
    if (a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) if (!valueEquals(a.items[i], b.items[i])) return false;
    return true;
  }
  if (a.tag === 'dict' && b.tag === 'dict') {
    const ak = Object.keys(a.entries).sort();
    const bk = Object.keys(b.entries).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!valueEquals(a.entries[ak[i]], b.entries[bk[i]])) return false;
    }
    return true;
  }
  throw new Error(`equality on ${a.tag} not supported`);
}

export function applyBuiltin(name: string, args: Value[]): Value {
  if (name === 'str_length') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`str_length(s: str)`);
    return { tag: 'int', v: args[0].v.length };
  }
  if (name === 'to_str') {
    if (args.length !== 1) throw new Error(`to_str(x)`);
    return { tag: 'str', v: valueToString(args[0]) };
  }
  if (name === 'str_slice') {
    if (args.length !== 3 || args[0].tag !== 'str' || args[1].tag !== 'int' || args[2].tag !== 'int') {
      throw new Error(`str_slice(s, start, end)`);
    }
    return { tag: 'str', v: args[0].v.slice(args[1].v, args[2].v) };
  }
  // ── list builtins ────────────────────────────────────────────────────────
  if (name === 'list_new') {
    return { tag: 'list', items: args.slice() };
  }
  if (name === 'list_push') {
    if (args.length !== 2 || args[0].tag !== 'list') throw new Error(`list_push(l: list, x): expected list arg`);
    return { tag: 'list', items: [...args[0].items, args[1]] };
  }
  if (name === 'list_get') {
    if (args.length !== 2 || args[0].tag !== 'list' || args[1].tag !== 'int') throw new Error(`list_get(l: list, i: int)`);
    const items = args[0].items;
    const i = args[1].v;
    if (i < 0 || i >= items.length) throw new Error(`list_get: index ${i} out of bounds [0, ${items.length})`);
    return items[i];
  }
  if (name === 'list_set') {
    if (args.length !== 3 || args[0].tag !== 'list' || args[1].tag !== 'int') throw new Error(`list_set(l: list, i: int, v)`);
    const items = args[0].items;
    const i = args[1].v;
    if (i < 0 || i >= items.length) throw new Error(`list_set: index ${i} out of bounds [0, ${items.length})`);
    const next = items.slice();
    next[i] = args[2];
    return { tag: 'list', items: next };
  }
  if (name === 'list_len') {
    if (args.length !== 1 || args[0].tag !== 'list') throw new Error(`list_len(l: list)`);
    return { tag: 'int', v: args[0].items.length };
  }
  if (name === 'list_slice') {
    if (args.length !== 3 || args[0].tag !== 'list' || args[1].tag !== 'int' || args[2].tag !== 'int') {
      throw new Error(`list_slice(l: list, start: int, end: int)`);
    }
    return { tag: 'list', items: args[0].items.slice(args[1].v, args[2].v) };
  }
  if (name === 'type_of') {
    if (args.length !== 1) throw new Error(`type_of(x)`);
    return { tag: 'str', v: args[0].tag };
  }
  // ── string introspection ───────────────────────────────────────────────
  if (name === 'str_chars') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`str_chars(s: str)`);
    const items: Value[] = [];
    for (const ch of args[0].v) items.push({ tag: 'str', v: ch });
    return { tag: 'list', items };
  }
  if (name === 'str_at') {
    if (args.length !== 2 || args[0].tag !== 'str' || args[1].tag !== 'int') throw new Error(`str_at(s: str, i: int)`);
    const i = args[1].v;
    if (i < 0 || i >= args[0].v.length) throw new Error(`str_at: index ${i} out of bounds [0, ${args[0].v.length})`);
    return { tag: 'str', v: args[0].v[i] };
  }
  if (name === 'str_find') {
    if (args.length !== 2 || args[0].tag !== 'str' || args[1].tag !== 'str') throw new Error(`str_find(s: str, sub: str)`);
    return { tag: 'int', v: args[0].v.indexOf(args[1].v) };
  }
  if (name === 'str_starts_with') {
    if (args.length !== 2 || args[0].tag !== 'str' || args[1].tag !== 'str') throw new Error(`str_starts_with(s: str, prefix: str)`);
    return { tag: 'bool', v: args[0].v.startsWith(args[1].v) };
  }
  if (name === 'str_ends_with') {
    if (args.length !== 2 || args[0].tag !== 'str' || args[1].tag !== 'str') throw new Error(`str_ends_with(s: str, suffix: str)`);
    return { tag: 'bool', v: args[0].v.endsWith(args[1].v) };
  }
  if (name === 'int_of_str') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`int_of_str(s: str)`);
    if (!/^-?\d+$/.test(args[0].v)) throw new Error(`int_of_str: not an integer: '${args[0].v}'`);
    return { tag: 'int', v: parseInt(args[0].v, 10) };
  }
  // ── list helpers ───────────────────────────────────────────────────────
  if (name === 'list_concat') {
    if (args.length !== 2 || args[0].tag !== 'list' || args[1].tag !== 'list') throw new Error(`list_concat(a: list, b: list)`);
    return { tag: 'list', items: [...args[0].items, ...args[1].items] };
  }
  if (name === 'list_reverse') {
    if (args.length !== 1 || args[0].tag !== 'list') throw new Error(`list_reverse(l: list)`);
    return { tag: 'list', items: args[0].items.slice().reverse() };
  }
  // ── character predicates ───────────────────────────────────────────────
  if (name === 'char_is_digit') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`char_is_digit(c: str)`);
    const c = args[0].v;
    return { tag: 'bool', v: c.length === 1 && c >= '0' && c <= '9' };
  }
  if (name === 'char_is_alpha') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`char_is_alpha(c: str)`);
    const c = args[0].v;
    return { tag: 'bool', v: c.length === 1 && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') };
  }
  if (name === 'char_is_alphanum') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`char_is_alphanum(c: str)`);
    const c = args[0].v;
    return { tag: 'bool', v: c.length === 1 && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') };
  }
  if (name === 'char_is_whitespace') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`char_is_whitespace(c: str)`);
    const c = args[0].v;
    return { tag: 'bool', v: c === ' ' || c === '\t' || c === '\n' || c === '\r' };
  }
  // ── control ────────────────────────────────────────────────────────────
  if (name === 'panic') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`panic(msg: str)`);
    throw new Error(`panic: ${args[0].v}`);
  }
  // ── dict builtins ────────────────────────────────────────────────────────
  if (name === 'dict_new') {
    if (args.length !== 0) throw new Error(`dict_new()`);
    return { tag: 'dict', entries: {} };
  }
  if (name === 'dict_set') {
    if (args.length !== 3 || args[0].tag !== 'dict' || args[1].tag !== 'str') throw new Error(`dict_set(d: dict, k: str, v)`);
    return { tag: 'dict', entries: { ...args[0].entries, [args[1].v]: args[2] } };
  }
  if (name === 'dict_get') {
    if (args.length !== 2 || args[0].tag !== 'dict' || args[1].tag !== 'str') throw new Error(`dict_get(d: dict, k: str)`);
    const v = args[0].entries[args[1].v];
    if (v === undefined) throw new Error(`dict_get: key '${args[1].v}' not found`);
    return v;
  }
  if (name === 'dict_has') {
    if (args.length !== 2 || args[0].tag !== 'dict' || args[1].tag !== 'str') throw new Error(`dict_has(d: dict, k: str)`);
    return { tag: 'bool', v: args[1].v in args[0].entries };
  }
  if (name === 'dict_keys') {
    if (args.length !== 1 || args[0].tag !== 'dict') throw new Error(`dict_keys(d: dict)`);
    return { tag: 'list', items: Object.keys(args[0].entries).sort().map(k => ({ tag: 'str' as const, v: k })) };
  }
  throw new Error(`unknown builtin '${name}'`);
}

type EffectStep = { kind: 'value'; v: Value } | { kind: 'pause' };

export function executeEffect(
  state: VMState,
  name: EffectName,
  args: Value[],
  replayIdx: Map<number, number>,
  replayPool: Map<number, EffectEntry[]>,
): EffectStep {
  const ip = state.ip;
  if (categoryOf(name) === 'wait') return executeWaitEffect(state, name, args, ip);
  // Only consume from the pool of entries that existed BEFORE this run started.
  // Same-ip effects added during recursion are NOT replayed.
  const usedCount = replayIdx.get(ip) ?? 0;
  const eligible = replayPool.get(ip) ?? [];
  const existing = eligible[usedCount];
  if (existing && !state.noReplay) {
    replayIdx.set(ip, usedCount + 1);
    return { kind: 'value', v: existing.recordedValue ?? { tag: 'unit' } };
  }
  // Fresh execution.
  const invocationCount = state.effects.filter(e => e.ip === ip).length;
  let v: Value;
  if (name === 'print') {
    const arg = args[0];
    if (!arg) throw new Error(`print expects 1 arg`);
    console.log(valueToString(arg));
    v = { tag: 'unit' };
  } else if (name === 'now') {
    const t = performNow(state.timeOverride ?? null);
    v = { tag: 'int', v: t };
  } else if (name === 'random_int') {
    const lo = args[0]; const hi = args[1];
    if (!lo || !hi || lo.tag !== 'int' || hi.tag !== 'int') throw new Error(`random_int(lo, hi: int)`);
    v = { tag: 'int', v: performRandomInt(lo.v, hi.v) };
  } else if (name === 'net_fetch') {
    const url = args[0];
    if (!url || url.tag !== 'str') throw new Error(`net_fetch(url: str)`);
    const body = performNetFetch(url.v);
    v = { tag: 'str', v: body };
  } else if (name === 'read_file') {
    const path = args[0];
    if (!path || path.tag !== 'str') throw new Error(`read_file(path: str)`);
    const content = performReadFile(path.v);
    v = { tag: 'str', v: content };
  } else if (name === 'write_file') {
    const path = args[0]; const body = args[1];
    if (!path || path.tag !== 'str' || !body || body.tag !== 'str') throw new Error(`write_file(path, body: str)`);
    performWriteFile(path.v, body.v);
    v = { tag: 'unit' };
  } else {
    throw new Error(`EFFECT: unhandled name '${name}'`);
  }
  state.effects.push({
    ip, invocationCount, effect: name as EffectEntry['effect'],
    recordedValue: v, status: 'committed',
  });
  return { kind: 'value', v };
}

function executeWaitEffect(state: VMState, name: EffectName, args: Value[], ip: number): EffectStep {
  // Look for an existing committed entry to replay (when resuming a long-running program).
  const committed = state.effects.find(e => e.ip === ip && e.effect === name && e.status === 'committed');
  if (committed && !state.noReplay) {
    return { kind: 'value', v: committed.recordedValue ?? { tag: 'unit' } };
  }

  // Look for pending entry promoted by an external resume (CLI --event for wait_for; time advance for wait_until).
  const pending = state.effects.find(e => e.ip === ip && e.effect === name && e.status === 'pending');
  if (pending) {
    if (name === 'wait_until') {
      const target = pending.waitUntilMs ?? 0;
      const now = state.timeOverride ?? Date.now();
      if (now < target) return { kind: 'pause' };
      pending.status = 'committed';
      pending.recordedValue = { tag: 'unit' };
      return { kind: 'value', v: { tag: 'unit' } };
    }
    if (name === 'wait_for') {
      if (pending.recordedValue === null) {
        // No external event arrived yet — re-pause.
        return { kind: 'pause' };
      }
      pending.status = 'committed';
      return { kind: 'value', v: pending.recordedValue };
    }
  }

  // First encounter at this ip: write a pending entry and pause.
  const invocationCount = state.effects.filter(e => e.ip === ip).length;
  const entry: EffectEntry = {
    ip, invocationCount, effect: name as EffectEntry['effect'],
    recordedValue: null, status: 'pending',
  };
  if (name === 'wait_for' && args[0]?.tag === 'str') {
    entry.eventName = args[0].v;
  }
  if (name === 'wait_until' && args[0]?.tag === 'int') {
    entry.waitUntilMs = args[0].v;
  }
  state.effects.push(entry);
  return { kind: 'pause' };
}

function valueToString(v: Value): string {
  if (v.tag === 'int')  return String(v.v);
  if (v.tag === 'bool') return v.v ? 'true' : 'false';
  if (v.tag === 'str')  return v.v;
  if (v.tag === 'unit') return '()';
  if (v.tag === 'closure') return '<fn>';
  if (v.tag === 'list') return '[' + v.items.map(valueRepr).join(', ') + ']';
  if (v.tag === 'dict') {
    const keys = Object.keys(v.entries).sort();
    return '{' + keys.map(k => `${JSON.stringify(k)}: ${valueRepr(v.entries[k])}`).join(', ') + '}';
  }
  return '<unknown>';
}

// Like valueToString but with strings quoted — used inside collections.
function valueRepr(v: Value): string {
  if (v.tag === 'str') return JSON.stringify(v.v);
  return valueToString(v);
}
