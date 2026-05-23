import { test, expect } from 'vitest';
import type { Program } from '../src/bytecode.js';
import { dcePass } from '../src/optimizer/dce.js';

// ── T35: unreachable code after HALT/RETURN ──────────────────────────────────

test('code after HALT is removed', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['HALT'], ['LOAD_CONST', 0], ['HALT']],
  };
  const out = dcePass(prog);
  expect(out.code).toEqual([['HALT']]);
});

test('code after RETURN inside fn body is removed', () => {
  // MAKE_CLOSURE [], 3, 5
  // JUMP 8
  // ENTER_BLOCK         <- 2 (not used as body start in this layout)
  // ENTER_BLOCK         <- 3 (bodyIp)
  // LOAD_CONST 0        <- 4
  // EXIT_BLOCK          <- 5
  // RETURN              <- 6
  // LOAD_CONST 0        <- 7 (dead)
  // STORE_VAR f         <- 8
  // HALT                <- 9
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [
      ['MAKE_CLOSURE', [], 3, 4],
      ['JUMP', 7],
      ['LOAD_CONST', 0],   // dead (between jump and body — not reachable from ip=0 flow)
      ['ENTER_BLOCK'],
      ['LOAD_CONST', 0],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['STORE_VAR', 'f'],
      ['HALT'],
    ],
  };
  const out = dcePass(prog);
  // IP 2 (LOAD_CONST 0 between JUMP and body) is dead: JUMP skips it, nothing else jumps to it.
  // But MAKE_CLOSURE marks bodyIp..bodyIp+bodyLen (3..7 exclusive = 3,4,5,6) reachable.
  // So: 0 (MAKE_CLOSURE), 1 (JUMP), 3 (ENTER_BLOCK), 4 (LOAD_CONST), 5 (EXIT_BLOCK),
  //     6 (RETURN), 7 (STORE_VAR), 8 (HALT) reachable; 2 dead.
  expect(out.code.length).toBe(8);
  const opNames = out.code.map(o => o[0]);
  expect(opNames).toEqual([
    'MAKE_CLOSURE', 'JUMP', 'ENTER_BLOCK', 'LOAD_CONST', 'EXIT_BLOCK', 'RETURN', 'STORE_VAR', 'HALT',
  ]);
});

// ── T36: JUMP-skip eliminates dead block ─────────────────────────────────────

test('JUMP-skip dead block is eliminated and target remapped', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [
      ['JUMP', 3],
      ['LOAD_CONST', 0],
      ['HALT'],
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  const out = dcePass(prog);
  expect(out.code).toEqual([
    ['JUMP', 1],
    ['LOAD_CONST', 0],
    ['HALT'],
  ]);
});

// ── T37: prune unreferenced constants from pool ──────────────────────────────

test('constants not referenced after DCE are pruned and indices remapped', () => {
  const prog: Program = {
    version: 1,
    constants: [
      { tag: 'int', v: 1 },
      { tag: 'int', v: 2 },
    ],
    code: [
      ['JUMP', 3],
      ['LOAD_CONST', 0],
      ['HALT'],
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  const out = dcePass(prog);
  expect(out.constants).toEqual([{ tag: 'int', v: 2 }]);
  expect((out.code.find(o => o[0] === 'LOAD_CONST') as ['LOAD_CONST', number])[1]).toBe(0);
});

test('all constants pruned when no LOAD_CONST survives', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 99 }],
    code: [['HALT'], ['LOAD_CONST', 0], ['HALT']],
  };
  const out = dcePass(prog);
  expect(out.constants).toEqual([]);
  expect(out.code).toEqual([['HALT']]);
});
