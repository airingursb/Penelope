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
