// Constant Folding pass.
// Repeatedly scans for LOAD_CONST, LOAD_CONST, BIN_OP triples and folds them.
// Rebuilds code array (and constant pool, deduped) on each fixpoint iteration.

import type { Program, Opcode } from '../bytecode.js';
import { internConstant, constantToValue, valueToConstant } from '../bytecode.js';
import type { Value } from '../ast.js';

export function constFoldPass(prog: Program): Program {
  let code = prog.code;
  let constants = [...prog.constants];
  let changed = true;
  while (changed) {
    changed = false;
    const next: Opcode[] = [];
    const jumpTargetMap = new Map<number, number>(); // old IP -> new IP
    for (let i = 0; i < code.length; i++) {
      jumpTargetMap.set(i, next.length);
      const op = code[i];
      // Look for fold pattern: LOAD_CONST, LOAD_CONST, BIN_OP
      if (
        op[0] === 'LOAD_CONST' &&
        i + 2 < code.length &&
        code[i+1][0] === 'LOAD_CONST' &&
        code[i+2][0] === 'BIN_OP'
      ) {
        const a = constantToValue(constants[op[1] as number]);
        const b = constantToValue(constants[(code[i+1] as ['LOAD_CONST', number])[1]]);
        const opn = (code[i+2] as ['BIN_OP', string])[1];
        const folded = tryFold(opn, a, b);
        if (folded) {
          const newIdx = internConstant(constants, valueToConstant(folded));
          next.push(['LOAD_CONST', newIdx]);
          jumpTargetMap.set(i+1, next.length - 1);
          jumpTargetMap.set(i+2, next.length - 1);
          i += 2;
          changed = true;
          continue;
        }
      }
      next.push(op);
    }
    // Re-map jump targets that point to old indices
    code = next.map(o => remapJumps(o, jumpTargetMap, code.length));
  }
  return { ...prog, constants, code };
}

function tryFold(op: string, a: Value, b: Value): Value | null {
  if (a.tag === 'int' && b.tag === 'int') {
    switch (op) {
      case '+': return { tag: 'int', v: a.v + b.v };
      case '-': return { tag: 'int', v: a.v - b.v };
      case '*': return { tag: 'int', v: a.v * b.v };
      case '/': if (b.v === 0) return null; return { tag: 'int', v: Math.trunc(a.v / b.v) };
      case '<':  return { tag: 'bool', v: a.v <  b.v };
      case '>':  return { tag: 'bool', v: a.v >  b.v };
      case '<=': return { tag: 'bool', v: a.v <= b.v };
      case '>=': return { tag: 'bool', v: a.v >= b.v };
      case '==': return { tag: 'bool', v: a.v === b.v };
      case '!=': return { tag: 'bool', v: a.v !== b.v };
    }
  }
  if (a.tag === 'str' && b.tag === 'str' && op === '+') {
    return { tag: 'str', v: a.v + b.v };
  }
  return null;
}

function remapJumps(op: Opcode, m: Map<number, number>, oldLen: number): Opcode {
  if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
    const oldTarget = op[1] as number;
    const newTarget = m.get(oldTarget);
    if (newTarget === undefined) {
      if (oldTarget === oldLen) return op;   // points past end
      throw new Error(`constFoldPass: orphan jump target ${oldTarget}`);
    }
    return [op[0], newTarget] as Opcode;
  }
  if (op[0] === 'MAKE_CLOSURE') {
    const oldBody = op[2] as number;
    const newBody = m.get(oldBody);
    if (newBody === undefined) throw new Error(`constFoldPass: orphan MAKE_CLOSURE body ${oldBody}`);
    return ['MAKE_CLOSURE', op[1] as string[], newBody, op[3] as number];
  }
  return op;
}
