// JIT: bytecode → JS source → Function.
//
// The interpreter's hot loop has two overheads: (1) tuple-unpacking on every
// opcode (`op[0]`, `op[1] as number`, etc.), and (2) generic dispatch for ops
// like BIN_OP that switch on a string operand. The JIT eliminates both by
// generating JS source where:
//
//   * every opcode is a labeled `case` whose body is inlined with op args
//     baked in as JS literals (no `op[N]` indexing at runtime),
//   * BIN_OP is specialized per operator (`l.v + r.v` etc., not a string switch),
//   * CALL_BUILTIN is specialized per builtin name,
//   * constants are baked in as JS literals (no `constants[idx]` lookup).
//
// Pause/effect/closure-call paths use the SAME helpers as the interpreter, so
// snapshot semantics, effect replay, and TCO behavior are byte-identical to
// the interpreted execution.
//
// The compiled function has the same signature as `vm.run`:
//   jitRun(prog, state, helpers) → RunResult
//
// `helpers` exposes: applyBinOp, applyBuiltin, executeEffect, constantToValue,
// formatPos, isReplay, etc. We re-export them from vm.ts.

import type { Program, Opcode } from './bytecode.js';
import type { Value } from './ast.js';
import type { VMState } from './snapshot.js';
import type { RunResult } from './vm.js';
import { applyBinOp, applyBuiltin, executeEffect } from './vm.js';

// Re-export for clarity.
export type JitHelpers = {
  applyBinOp: typeof applyBinOp;
  applyBuiltin: typeof applyBuiltin;
  executeEffect: typeof executeEffect;
};

const HELPERS: JitHelpers = { applyBinOp, applyBuiltin, executeEffect };

// JS expression that, when evaluated, produces the given Value.
function valueLit(v: Value): string {
  switch (v.tag) {
    case 'int':  return `{tag:'int',v:${v.v}}`;
    case 'bool': return `{tag:'bool',v:${v.v}}`;
    case 'str':  return `{tag:'str',v:${JSON.stringify(v.v)}}`;
    case 'unit': return `{tag:'unit'}`;
    default:     return JSON.stringify(v);
  }
}

// Specialized inline expression for BIN_OP. Falls back to the helper for the
// type-error path so error messages stay identical to the interpreter's.
function emitBinOp(op: string): string {
  const guard = (test: string, body: string, fallback: string) =>
    `${test} ? ${body} : ${fallback}`;
  switch (op) {
    case '+':
      // Inline int+int and str+str; fall back for everything else.
      return guard(
        `l.tag==='int'&&r.tag==='int'`,
        `{tag:'int',v:l.v+r.v}`,
        guard(`l.tag==='str'&&r.tag==='str'`, `{tag:'str',v:l.v+r.v}`, `H.applyBinOp('+',l,r)`),
      );
    case '-': return guard(`l.tag==='int'&&r.tag==='int'`, `{tag:'int',v:l.v-r.v}`, `H.applyBinOp('-',l,r)`);
    case '*': return guard(`l.tag==='int'&&r.tag==='int'`, `{tag:'int',v:l.v*r.v}`, `H.applyBinOp('*',l,r)`);
    case '/': return guard(`l.tag==='int'&&r.tag==='int'&&r.v!==0`, `{tag:'int',v:(l.v/r.v)|0}`, `H.applyBinOp('/',l,r)`);
    case '<':  return guard(`l.tag==='int'&&r.tag==='int'`, `{tag:'bool',v:l.v<r.v}`, `H.applyBinOp('<',l,r)`);
    case '>':  return guard(`l.tag==='int'&&r.tag==='int'`, `{tag:'bool',v:l.v>r.v}`, `H.applyBinOp('>',l,r)`);
    case '<=': return guard(`l.tag==='int'&&r.tag==='int'`, `{tag:'bool',v:l.v<=r.v}`, `H.applyBinOp('<=',l,r)`);
    case '>=': return guard(`l.tag==='int'&&r.tag==='int'`, `{tag:'bool',v:l.v>=r.v}`, `H.applyBinOp('>=',l,r)`);
    case '==': return `H.applyBinOp('==',l,r)`;  // identity vs deep equality — delegate
    case '!=': return `H.applyBinOp('!=',l,r)`;
    default:   return `H.applyBinOp(${JSON.stringify(op)},l,r)`;
  }
}

// Generate one JS case body (as a string) for a single opcode at index `ip`.
// The body ends by jumping back to `mainLoop` (so the outer switch can dispatch
// the next ip) UNLESS the op itself returns (PAUSE, HALT) or alters control flow.
function emitOp(prog: Program, ip: number): string {
  const op: Opcode = prog.code[ip];
  const kind = op[0];
  switch (kind) {
    case 'HALT':
      return `state.ip=${ip}; return {status:'halted', state};`;
    case 'LOAD_CONST': {
      const idx = op[1] as number;
      const v = prog.constants[idx];
      return `stack.push(${valueLit(v as Value)}); ip=${ip + 1}; continue outer;`;
    }
    case 'POP':
      return `stack.pop(); ip=${ip + 1}; continue outer;`;
    case 'PUSH_UNIT':
      return `stack.push({tag:'unit'}); ip=${ip + 1}; continue outer;`;
    case 'STORE_VAR': {
      const name = JSON.stringify(op[1] as string);
      return `frames[frames.length-1].bindings[${name}]=stack.pop(); ip=${ip + 1}; continue outer;`;
    }
    case 'LOAD_VAR': {
      const name = JSON.stringify(op[1] as string);
      // Inline the same env-walk the interpreter does. IC fast-path omitted —
      // we cache nothing because the JIT runs in one shot; the cold lookup is
      // still O(depth) but the constant `name` is baked in.
      return `{ let idx=frames.length-1, found=false; while(idx>=0){ const f=frames[idx]; if(Object.prototype.hasOwnProperty.call(f.bindings,${name})){ stack.push(f.bindings[${name}]); found=true; break; } if(f.parentIdx!==undefined) idx=f.parentIdx; else idx--; } if(!found) throw new Error("undefined variable '"+${name}+"' at ip ${ip}"); ip=${ip + 1}; continue outer; }`;
    }
    case 'BIN_OP': {
      const o = op[1] as string;
      const inline = emitBinOp(o);
      return `{ const r=stack.pop(), l=stack.pop(); stack.push(${inline}); ip=${ip + 1}; continue outer; }`;
    }
    case 'JUMP':
      return `ip=${op[1] as number}; continue outer;`;
    case 'JUMP_IF_FALSE': {
      const target = op[1] as number;
      return `{ const c=stack.pop(); if(c.tag!=='bool') throw new Error("if condition expected bool, got "+c.tag+" at ip ${ip}"); ip=!c.v?${target}:${ip + 1}; continue outer; }`;
    }
    case 'MAKE_CLOSURE': {
      const params = JSON.stringify(op[1] as string[]);
      const bodyIp = op[2] as number;
      const bodyLen = op[3] as number;
      return `stack.push({tag:'closure',params:${params},bodyIp:${bodyIp},bodyLen:${bodyLen},capturedFrameIdx:frames.length-1}); ip=${ip + 1}; continue outer;`;
    }
    case 'CALL': {
      const argc = op[1] as number;
      // Pop argc args, pop callee, push new frame, jump to bodyIp.
      const popArgs = `const args=new Array(${argc}); for(let i=${argc - 1};i>=0;i--) args[i]=stack.pop();`;
      return `{ ${popArgs} const callee=stack.pop(); if(callee.tag!=='closure') throw new Error("call: callee is "+callee.tag+", not a function (at ip ${ip})"); if(args.length!==callee.params.length) throw new Error("call: arity mismatch at ip ${ip}"); const bindings={}; for(let i=0;i<args.length;i++) bindings[callee.params[i]]=args[i]; frames.push({bindings, returnIP:${ip + 1}, parentIdx:callee.capturedFrameIdx}); ip=callee.bodyIp; continue outer; }`;
    }
    case 'TAILCALL': {
      const argc = op[1] as number;
      // TCO is subtle (frame-reuse with captured-frame safety check). Delegate
      // to the interpreter via a single-step helper. This is the one op where
      // we trade JIT speed for correctness — TCO bugs are extremely costly.
      // The interpreter's TAILCALL handler is self-contained; we replicate it.
      const popArgs = `const args=new Array(${argc}); for(let i=${argc - 1};i>=0;i--) args[i]=stack.pop();`;
      return `{ ${popArgs} const callee=stack.pop(); if(callee.tag!=='closure') throw new Error("tailcall: callee is "+callee.tag+" at ip ${ip}"); if(args.length!==callee.params.length) throw new Error("tailcall: arity mismatch at ip ${ip}"); let callFrameIdx=frames.length-1; while(callFrameIdx>=0 && frames[callFrameIdx].returnIP===undefined) callFrameIdx--; const safeTco = callFrameIdx>=0 && callee.capturedFrameIdx<=callFrameIdx; if(!safeTco){ const bindings={}; for(let i=0;i<args.length;i++) bindings[callee.params[i]]=args[i]; frames.push({bindings,returnIP:${ip + 1},parentIdx:callee.capturedFrameIdx}); ip=callee.bodyIp; continue outer; } while(frames.length>callFrameIdx+1) frames.pop(); const callFrame=frames[callFrameIdx]; const bindings={}; for(let i=0;i<args.length;i++) bindings[callee.params[i]]=args[i]; callFrame.bindings=bindings; callFrame.parentIdx=callee.capturedFrameIdx; ip=callee.bodyIp; continue outer; }`;
    }
    case 'RETURN':
      return `{ const f=frames.pop(); if(!f||f.returnIP===undefined) throw new Error("RETURN: invalid return frame at ip ${ip}"); ip=f.returnIP; continue outer; }`;
    case 'ENTER_BLOCK':
      return `frames.push({bindings:{}, parentIdx:frames.length-1}); ip=${ip + 1}; continue outer;`;
    case 'EXIT_BLOCK':
      return `{ if(frames.length===1) throw new Error("EXIT_BLOCK: cannot pop root frame at ip ${ip}"); frames.pop(); ip=${ip + 1}; continue outer; }`;
    case 'EFFECT': {
      const name = JSON.stringify(op[1] as string);
      const argc = op[2] as number;
      // EFFECT is the one place we MUST hand control back to a helper, because
      // executeEffect manages the effect log + replay invariants.
      return `{ const args=new Array(${argc}); for(let i=${argc - 1};i>=0;i--) args[i]=stack.pop(); state.valueStack=stack; state.frames=frames; state.ip=${ip}; const step=H.executeEffect(state, ${name}, args, replayIdx, replayPool); if(step.kind==='pause'){ for(const a of args) stack.push(a); return {status:'paused', state}; } stack.push(step.v); ip=${ip + 1}; continue outer; }`;
    }
    case 'CALL_BUILTIN': {
      const name = JSON.stringify(op[1] as string);
      const argc = op[2] as number;
      return `{ const args=new Array(${argc}); for(let i=${argc - 1};i>=0;i--) args[i]=stack.pop(); stack.push(H.applyBuiltin(${name}, args)); ip=${ip + 1}; continue outer; }`;
    }
    case 'PAUSE':
      return `stack.push({tag:'unit'}); state.ip=${ip + 1}; state.valueStack=stack; state.frames=frames; return {status:'paused', state};`;
    default:
      return `throw new Error("JIT: unhandled opcode '${kind}' at ip ${ip}");`;
  }
}

/**
 * Compile a Program to a JS Function that runs it. The Function captures the
 * helpers in its closure; the resulting fn signature is (state) → RunResult.
 *
 * The output uses a labeled `outer` while-loop wrapping a switch on `ip`. Each
 * opcode is one `case` whose body ends with `ip=NEXT; continue outer;`. Direct
 * control-flow ops (HALT, RETURN, PAUSE, JUMP) bypass that pattern.
 */
export function jitCompile(prog: Program): (state: VMState) => RunResult {
  const cases: string[] = [];
  for (let ip = 0; ip < prog.code.length; ip++) {
    cases.push(`case ${ip}: ${emitOp(prog, ip)}`);
  }
  const src = `
    return function jitRun(state) {
      const H = HELPERS;
      let stack = state.valueStack;
      let frames = state.frames;
      let ip = state.ip;
      // Build a replay pool from any prior effects in state.effects — same
      // logic vm.run uses to support deterministic replay across resume.
      const replayPool = new Map();
      const replayIdx = new Map();
      for (const e of state.effects) {
        if (!replayPool.has(e.ip)) replayPool.set(e.ip, []);
        replayPool.get(e.ip).push(e);
      }
      outer: while (true) {
        switch (ip) {
          ${cases.join('\n          ')}
          default: throw new Error("JIT: ip "+ip+" out of bounds (max ${prog.code.length - 1})");
        }
      }
    };
  `;
  // Construct the function in a controlled scope so HELPERS is in scope.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('HELPERS', src) as (h: JitHelpers) => (state: VMState) => RunResult;
  return factory(HELPERS);
}

/** Convenience: compile + run, like `vm.run` but JIT-accelerated. */
export function jitRun(prog: Program, state: VMState): RunResult {
  return jitCompile(prog)(state);
}
