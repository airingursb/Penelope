// Peephole pass: small local rewrites that clean up after other passes.
//   1. PUSH_UNIT, POP    → (drop both)
//   2. LOAD_CONST, POP   → (drop both)
//   3. JUMP-to-JUMP      → collapse chain to final target

import type { Program, Opcode } from '../bytecode.js';

export function peepholePass(prog: Program): Program {
  let code = prog.code;
  let changed = true;
  while (changed) {
    changed = false;

    const chained = followJumpChains(code);
    if (chained.changed) {
      code = chained.code;
      changed = true;
    }

    const next: Opcode[] = [];
    const map = new Map<number, number>();
    for (let i = 0; i < code.length; i++) {
      map.set(i, next.length);
      const a = code[i];
      const b = code[i + 1];
      if ((a[0] === 'PUSH_UNIT' || a[0] === 'LOAD_CONST') && b && b[0] === 'POP') {
        map.set(i + 1, next.length);
        i++;
        changed = true;
        continue;
      }
      next.push(a);
    }
    map.set(code.length, next.length);

    if (changed) {
      code = next.map(op => remap(op, map));
    }
  }
  return { ...prog, code };
}

function followJumpChains(code: Opcode[]): { changed: boolean; code: Opcode[] } {
  let changed = false;
  const out: Opcode[] = code.map(op => {
    if (op[0] !== 'JUMP' && op[0] !== 'JUMP_IF_FALSE') return op;
    const original = op[1] as number;
    let t = original;
    const seen = new Set<number>();
    while (t < code.length && code[t][0] === 'JUMP' && !seen.has(t)) {
      seen.add(t);
      t = code[t][1] as number;
    }
    if (t !== original) {
      changed = true;
      return [op[0], t] as Opcode;
    }
    return op;
  });
  return { changed, code: out };
}

function remap(op: Opcode, m: Map<number, number>): Opcode {
  if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
    const t = m.get(op[1] as number);
    return t === undefined ? op : ([op[0], t] as Opcode);
  }
  if (op[0] === 'MAKE_CLOSURE') {
    const t = m.get(op[2] as number);
    return t === undefined ? op : (['MAKE_CLOSURE', op[1] as string[], t, op[3] as number] as Opcode);
  }
  return op;
}
