// Inline Caches pass.
// - LOAD_VAR: encode static `framesUp` from the lexical block-depth stack.
//   Skips inside closure bodies (their static depth is independent of the caller).
// - EFFECT: annotate with lexical ordinal (per-program EFFECT index).

import type { Program, Opcode, LoadVarIC } from '../bytecode.js';

export function icPass(prog: Program): Program {
  const bindings: Array<Set<string>> = [new Set()];
  const code: Opcode[] = [];
  let effectOrdinal = 0;

  let insideClosureBody = false;
  let closureBodyEnd = -1;

  for (let i = 0; i < prog.code.length; i++) {
    if (insideClosureBody && i >= closureBodyEnd) insideClosureBody = false;

    const op = prog.code[i];

    if (op[0] === 'MAKE_CLOSURE') {
      const bodyIp = op[2] as number;
      const bodyLen = op[3] as number;
      insideClosureBody = (i + 2 === bodyIp);
      closureBodyEnd = bodyIp + bodyLen;
      code.push(op);
      continue;
    }

    if (insideClosureBody) {
      if (op[0] === 'EFFECT') {
        code.push(['EFFECT', op[1] as string, op[2] as number, effectOrdinal]);
        effectOrdinal++;
      } else {
        code.push(op);
      }
      continue;
    }

    switch (op[0]) {
      case 'ENTER_BLOCK':
        bindings.push(new Set());
        code.push(op);
        break;
      case 'EXIT_BLOCK':
        bindings.pop();
        if (bindings.length === 0) bindings.push(new Set());
        code.push(op);
        break;
      case 'STORE_VAR': {
        const name = op[1] as string;
        bindings[bindings.length - 1].add(name);
        code.push(op);
        break;
      }
      case 'LOAD_VAR': {
        const name = op[1] as string;
        let framesUp = -1;
        for (let d = bindings.length - 1; d >= 0; d--) {
          if (bindings[d].has(name)) {
            framesUp = (bindings.length - 1) - d;
            break;
          }
        }
        if (framesUp >= 0) {
          const ic: LoadVarIC = { framesUp };
          code.push(['LOAD_VAR', name, ic]);
        } else {
          code.push(op);
        }
        break;
      }
      case 'EFFECT':
        code.push(['EFFECT', op[1] as string, op[2] as number, effectOrdinal]);
        effectOrdinal++;
        break;
      default:
        code.push(op);
    }
  }

  return { ...prog, code };
}
