// Penelope VM. Stack-based bytecode interpreter.
// State is VMState from snapshot.ts; the VM mutates it in place.

import type { Program, Opcode } from './bytecode.js';
import type { VMState, Frame, EffectEntry } from './snapshot.js';
import type { Value } from './ast.js';
import { constantToValue } from './bytecode.js';
import { performNetFetch, performNow, performRandomInt, performReadFile, performWriteFile, categoryOf, EFFECT_NAMES } from './effects.js';
import type { EffectName } from './effects.js';

export type RunResult =
  | { status: 'halted'; state: VMState }
  | { status: 'paused'; state: VMState };

export function freshState(): VMState {
  return {
    ip: 0,
    valueStack: [],
    frames: [{ bindings: {} }],
    effects: [],
  };
}

export function run(prog: Program, initialState?: VMState): RunResult {
  const state = initialState ?? freshState();
  return runUntilStop(prog, state);
}

function runUntilStop(prog: Program, state: VMState): RunResult {
  while (true) {
    const op = prog.code[state.ip];
    if (!op) throw new Error(`VM: IP ${state.ip} out of bounds`);
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
        if (!found) throw new Error(`VM: undefined variable '${name}' at ip ${state.ip}`);
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
        if (c.tag !== 'bool') throw new Error(`JUMP_IF_FALSE: expected bool, got ${c.tag}`);
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
        if (callee.tag !== 'closure') throw new Error(`CALL: callee is ${callee.tag}, not closure`);
        if (args.length !== callee.params.length) {
          throw new Error(`CALL: arity mismatch (expected ${callee.params.length}, got ${args.length})`);
        }
        const bindings: Record<string, Value> = {};
        for (let i = 0; i < args.length; i++) bindings[callee.params[i]] = args[i];
        state.frames.push({ bindings, returnIP: state.ip + 1, parentIdx: callee.capturedFrameIdx });
        state.ip = callee.bodyIp;
        break;
      }
      case 'RETURN': {
        const f = state.frames.pop();
        if (!f || f.returnIP === undefined) throw new Error(`RETURN: invalid return frame`);
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

function applyBinOp(o: string, l: Value, r: Value): Value {
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
    if (l.tag !== r.tag) throw new Error(`BIN_OP ${o}: type mismatch`);
    let eq: boolean;
    if (l.tag === 'unit') eq = true;
    else if (l.tag === 'closure' || (r as any).tag === 'closure') throw new Error(`BIN_OP ${o}: closures not comparable`);
    else eq = (l as any).v === (r as any).v;
    return { tag: 'bool', v: o === '==' ? eq : !eq };
  }
  throw new Error(`BIN_OP: unknown op '${o}'`);
}
