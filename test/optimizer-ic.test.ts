import { test, expect } from 'vitest';
import { icPass } from '../src/optimizer/ic.js';
import { run, freshState } from '../src/vm.js';
import type { Program } from '../src/bytecode.js';

// ── T39: LOAD_VAR static framesUp ────────────────────────────────────────────

test('LOAD_VAR for top-level binding records framesUp=0', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'x'],
      ['LOAD_VAR', 'x', null],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  const load = out.code[2] as ['LOAD_VAR', string, { framesUp: number }];
  expect(load[2]).toEqual({ framesUp: 0 });
});

test('LOAD_VAR inside its own block records framesUp=0', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [
      ['ENTER_BLOCK'],
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'y'],
      ['LOAD_VAR', 'y', null],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  const load = out.code[3] as ['LOAD_VAR', string, { framesUp: number }];
  expect(load[2]).toEqual({ framesUp: 0 });
});

test('LOAD_VAR for outer binding from inside a block records framesUp>0', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'x'],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', null],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  const load = out.code[3] as ['LOAD_VAR', string, { framesUp: number }];
  expect(load[2]).toEqual({ framesUp: 1 });
});

test('LOAD_VAR inside closure body leaves IC slot null (depth resets)', () => {
  // MAKE_CLOSURE [x], bodyIp=2, bodyLen=4
  // JUMP 6
  // ENTER_BLOCK     <- 2 (body)
  // LOAD_VAR x      <- 3 (param — not seen by outer bindings stack)
  // EXIT_BLOCK
  // RETURN
  // HALT
  const prog: Program = {
    version: 1,
    constants: [],
    code: [
      ['MAKE_CLOSURE', ['x'], 2, 4],
      ['JUMP', 6],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', null],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  const load = out.code[3] as ['LOAD_VAR', string, unknown];
  expect(load[2]).toBeNull();
});

test('unknown LOAD_VAR (no enclosing STORE) keeps IC slot null', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['LOAD_VAR', 'undef', null], ['HALT']],
  };
  const out = icPass(prog);
  expect((out.code[0] as ['LOAD_VAR', string, unknown])[2]).toBeNull();
});

// ── T40: VM honors IC slot ───────────────────────────────────────────────────

test('VM uses LOAD_VAR IC slot when present (binding actually in expected frame)', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 99 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'x'],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', { framesUp: 1 }],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  const r = run(prog);
  expect(r.state.valueStack).toEqual([{ tag: 'int', v: 99 }]);
});

test('VM falls back to chain walk on IC miss', () => {
  // IC says framesUp=2 but x is actually in frame 0; need walk fallback.
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 7 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'x'],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', { framesUp: 99 }],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  const r = run(prog);
  expect(r.state.valueStack).toEqual([{ tag: 'int', v: 7 }]);
});

// ── T41: EFFECT lexical ordinal ──────────────────────────────────────────────

test('EFFECT opcodes get IC slot = lexical ordinal', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'a' }, { tag: 'str', v: 'b' }],
    code: [
      ['LOAD_CONST', 0],
      ['EFFECT', 'print', 1, null],
      ['LOAD_CONST', 1],
      ['EFFECT', 'print', 1, null],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  expect((out.code[1] as ['EFFECT', string, number, number])[3]).toBe(0);
  expect((out.code[3] as ['EFFECT', string, number, number])[3]).toBe(1);
});
