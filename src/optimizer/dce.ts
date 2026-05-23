// Dead Code Elimination pass.
// 1. Mark reachable opcodes via BFS from IP 0.
// 2. Rebuild code keeping only reachable; remap jump targets and MAKE_CLOSURE body refs.
// 3. Prune unreferenced constants from the pool; remap LOAD_CONST indices.

import type { Program, Opcode } from '../bytecode.js';

export function dcePass(prog: Program): Program {
  const reachable = computeReachable(prog);
  const oldToNew = new Map<number, number>();
  const next: Opcode[] = [];
  for (let i = 0; i < prog.code.length; i++) {
    if (reachable.has(i)) {
      oldToNew.set(i, next.length);
      next.push(prog.code[i]);
    }
  }
  oldToNew.set(prog.code.length, next.length);
  const remapped = next.map(o => remapTargets(o, oldToNew));

  const used = new Set<number>();
  for (const op of remapped) {
    if (op[0] === 'LOAD_CONST') used.add(op[1] as number);
  }
  const oldToNewConst = new Map<number, number>();
  const prunedConstants: typeof prog.constants = [];
  for (let i = 0; i < prog.constants.length; i++) {
    if (used.has(i)) {
      oldToNewConst.set(i, prunedConstants.length);
      prunedConstants.push(prog.constants[i]);
    }
  }
  const finalCode = remapped.map(op => {
    if (op[0] === 'LOAD_CONST') {
      return ['LOAD_CONST', oldToNewConst.get(op[1] as number)!] as Opcode;
    }
    return op;
  });
  return { ...prog, constants: prunedConstants, code: finalCode };
}

function computeReachable(prog: Program): Set<number> {
  const reach = new Set<number>();
  const queue: number[] = [0];
  while (queue.length > 0) {
    const ip = queue.shift()!;
    if (reach.has(ip)) continue;
    if (ip < 0 || ip >= prog.code.length) continue;
    reach.add(ip);
    const op = prog.code[ip];
    switch (op[0]) {
      case 'HALT':
      case 'RETURN':
        break;
      case 'JUMP':
        queue.push(op[1] as number);
        break;
      case 'JUMP_IF_FALSE':
        queue.push(op[1] as number);
        queue.push(ip + 1);
        break;
      case 'MAKE_CLOSURE': {
        const bodyIp = op[2] as number;
        const bodyLen = op[3] as number;
        for (let j = 0; j < bodyLen; j++) queue.push(bodyIp + j);
        queue.push(ip + 1);
        break;
      }
      default:
        queue.push(ip + 1);
        break;
    }
  }
  return reach;
}

function remapTargets(op: Opcode, m: Map<number, number>): Opcode {
  if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
    const t = m.get(op[1] as number);
    if (t === undefined) throw new Error(`dcePass: orphan jump target ${op[1]}`);
    return [op[0], t] as Opcode;
  }
  if (op[0] === 'MAKE_CLOSURE') {
    const oldBody = op[2] as number;
    const newBody = m.get(oldBody);
    if (newBody === undefined) throw new Error(`dcePass: orphan MAKE_CLOSURE body ${oldBody}`);
    return ['MAKE_CLOSURE', op[1] as string[], newBody, op[3] as number];
  }
  return op;
}
