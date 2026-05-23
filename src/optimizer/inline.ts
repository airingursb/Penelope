// Function Inlining pass.
// Narrow: inlines single-use closures whose body is pure (no PAUSE/EFFECT/CALL/CALL_BUILTIN).
// Layout assumed (from compiler): MAKE_CLOSURE, JUMP-past-body, body opcodes (incl. trailing RETURN), STORE_VAR f.

import type { Program, Opcode } from '../bytecode.js';

export type InlineCandidate = {
  name: string;
  makeClosureIp: number;
  storeVarIp: number;
  callSiteIp: number;
  calleeLoadIp: number;
  params: string[];
  bodyIp: number;
  bodyLen: number;
};

export function findInliningCandidates(prog: Program): InlineCandidate[] {
  const loadVarSites = new Map<string, number[]>();
  for (let i = 0; i < prog.code.length; i++) {
    const op = prog.code[i];
    if (op[0] === 'LOAD_VAR') {
      const name = op[1] as string;
      const arr = loadVarSites.get(name) ?? [];
      arr.push(i);
      loadVarSites.set(name, arr);
    }
  }

  const candidates: InlineCandidate[] = [];
  for (let i = 0; i < prog.code.length; i++) {
    const op = prog.code[i];
    if (op[0] !== 'MAKE_CLOSURE') continue;
    const params = op[1] as string[];
    const bodyIp = op[2] as number;
    const bodyLen = op[3] as number;

    // Expect JUMP at i+1 jumping past the body (which ends with RETURN).
    const jumpOp = prog.code[i + 1];
    if (!jumpOp || jumpOp[0] !== 'JUMP') continue;

    // Compiler emits body then RETURN; bodyLen includes RETURN.
    // So RETURN is at bodyIp + bodyLen - 1; STORE_VAR f is at bodyIp + bodyLen.
    const returnIp = bodyIp + bodyLen - 1;
    const returnOp = prog.code[returnIp];
    if (!returnOp || returnOp[0] !== 'RETURN') continue;

    const storeIp = bodyIp + bodyLen;
    const storeOp = prog.code[storeIp];
    if (!storeOp || storeOp[0] !== 'STORE_VAR') continue;
    const name = storeOp[1] as string;

    // Body must be pure (exclude RETURN from the check).
    let pure = true;
    for (let j = bodyIp; j < returnIp; j++) {
      const bop = prog.code[j];
      if (bop[0] === 'PAUSE' || bop[0] === 'EFFECT' || bop[0] === 'CALL' || bop[0] === 'CALL_BUILTIN') {
        pure = false;
        break;
      }
    }
    if (!pure) continue;

    // Exactly one LOAD_VAR of this name; that load is followed (after argc pushes) by CALL.
    const uses = loadVarSites.get(name) ?? [];
    if (uses.length !== 1) continue;
    const calleeLoadIp = uses[0];
    const callSiteIp = findFollowingCall(prog, calleeLoadIp, params.length);
    if (callSiteIp < 0) continue;

    candidates.push({
      name, makeClosureIp: i, storeVarIp: storeIp,
      callSiteIp, calleeLoadIp, params, bodyIp, bodyLen,
    });
  }
  return candidates;
}

function findFollowingCall(prog: Program, loadVarIp: number, expectedArgc: number): number {
  let pushCount = 0;
  for (let i = loadVarIp + 1; i < prog.code.length; i++) {
    const op = prog.code[i];
    if (op[0] === 'CALL') {
      if ((op[1] as number) === expectedArgc && pushCount === expectedArgc) return i;
      return -1;
    }
    if (op[0] === 'LOAD_CONST' || op[0] === 'LOAD_VAR' || op[0] === 'PUSH_UNIT') {
      pushCount++;
      continue;
    }
    return -1;
  }
  return -1;
}

export function inlinePass(prog: Program): Program {
  let cur = prog;
  while (true) {
    const cands = findInliningCandidates(cur);
    if (cands.length === 0) break;
    const next = applyInline(cur, cands[0]);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function applyInline(prog: Program, c: InlineCandidate): Program {
  const argc = c.params.length;

  const removedRanges: Array<[number, number]> = [
    [c.makeClosureIp, c.storeVarIp],
    [c.calleeLoadIp, c.calleeLoadIp],
    [c.callSiteIp, c.callSiteIp],
  ];
  const isRemoved = (ip: number): boolean =>
    removedRanges.some(([s, e]) => ip >= s && ip <= e);
  for (let i = 0; i < prog.code.length; i++) {
    if (isRemoved(i)) continue;
    const op = prog.code[i];
    if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
      const t = op[1] as number;
      if (isRemoved(t)) return prog;
    }
    if (op[0] === 'MAKE_CLOSURE') {
      const bodyIp = op[2] as number;
      if (isRemoved(bodyIp)) return prog;
    }
  }

  const before = prog.code.slice(0, c.makeClosureIp);
  const middle = prog.code.slice(c.storeVarIp + 1, c.calleeLoadIp);
  const args = prog.code.slice(c.calleeLoadIp + 1, c.callSiteIp);
  // Exclude RETURN (last opcode of bodyLen) — inlined body doesn't return, it leaves trailing value on stack.
  const bodyOps = prog.code.slice(c.bodyIp, c.bodyIp + c.bodyLen - 1);
  const after = prog.code.slice(c.callSiteIp + 1);

  const paramStores: Opcode[] = c.params.slice().reverse().map(p => ['STORE_VAR', p]);
  const inlinedFragment: Opcode[] = [
    ['ENTER_BLOCK'],
    ...paramStores,
    ...bodyOps,
    ['EXIT_BLOCK'],
  ];

  const newCode: Opcode[] = [...before, ...middle, ...args, ...inlinedFragment, ...after];

  const map = new Map<number, number>();
  for (let i = 0; i < c.makeClosureIp; i++) map.set(i, i);
  let cursor = c.makeClosureIp;
  for (let i = c.storeVarIp + 1; i < c.calleeLoadIp; i++) {
    map.set(i, cursor);
    cursor++;
  }
  for (let i = c.calleeLoadIp + 1; i < c.callSiteIp; i++) {
    map.set(i, cursor);
    cursor++;
  }
  cursor += inlinedFragment.length;
  for (let i = c.callSiteIp + 1; i < prog.code.length; i++) {
    map.set(i, cursor);
    cursor++;
  }
  map.set(prog.code.length, cursor);

  const remapped = newCode.map(op => {
    if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
      const t = op[1] as number;
      const nt = map.get(t);
      return nt === undefined ? op : ([op[0], nt] as Opcode);
    }
    if (op[0] === 'MAKE_CLOSURE') {
      const oldBody = op[2] as number;
      const nb = map.get(oldBody);
      return nb === undefined ? op : (['MAKE_CLOSURE', op[1] as string[], nb, op[3] as number] as Opcode);
    }
    return op;
  });

  return { ...prog, code: remapped };
}
