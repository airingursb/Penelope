import { test, expect } from 'vitest';
import { peepholePass } from '../src/optimizer/peephole.js';
import type { Program } from '../src/bytecode.js';

// ── T47: PUSH_UNIT + POP elimination ─────────────────────────────────────────

test('PUSH_UNIT immediately followed by POP is removed', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['PUSH_UNIT'], ['POP'], ['HALT']],
  };
  expect(peepholePass(prog).code).toEqual([['HALT']]);
});

test('PUSH_UNIT then POP in middle of program', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 7 }],
    code: [['LOAD_CONST', 0], ['PUSH_UNIT'], ['POP'], ['HALT']],
  };
  expect(peepholePass(prog).code).toEqual([['LOAD_CONST', 0], ['HALT']]);
});

// ── T48: JUMP-to-JUMP chain collapse ─────────────────────────────────────────

test('JUMP targeting another JUMP collapses to final target', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 0 }],
    code: [
      ['JUMP', 2],
      ['LOAD_CONST', 0],
      ['JUMP', 4],
      ['LOAD_CONST', 0],
      ['HALT'],
    ],
  };
  const out = peepholePass(prog);
  expect((out.code[0] as ['JUMP', number])[1]).toBe(4);
});

test('cyclic JUMP chain does not loop forever', () => {
  // Two JUMPs that point at each other — guard must stop.
  const prog: Program = {
    version: 1, constants: [],
    code: [
      ['JUMP', 1],
      ['JUMP', 0],
      ['HALT'],
    ],
  };
  expect(() => peepholePass(prog)).not.toThrow();
});

// ── T49: LOAD_CONST + POP elimination ────────────────────────────────────────

test('LOAD_CONST immediately followed by POP is removed', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 99 }],
    code: [['LOAD_CONST', 0], ['POP'], ['HALT']],
  };
  expect(peepholePass(prog).code).toEqual([['HALT']]);
});

test('multiple LOAD_CONST+POP and PUSH_UNIT+POP pairs all eliminated', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 1 }],
    code: [
      ['LOAD_CONST', 0],
      ['POP'],
      ['PUSH_UNIT'],
      ['POP'],
      ['HALT'],
    ],
  };
  expect(peepholePass(prog).code).toEqual([['HALT']]);
});

test('LOAD_CONST without POP is preserved', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 5 }],
    code: [['LOAD_CONST', 0], ['HALT']],
  };
  expect(peepholePass(prog).code).toEqual([['LOAD_CONST', 0], ['HALT']]);
});

test('jump targets remapped after pair elimination', () => {
  // JUMP 3 (skip LOAD_CONST + POP) then HALT. After peephole the LC+POP gone, JUMP target shifts.
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 1 }],
    code: [
      ['JUMP', 3],
      ['LOAD_CONST', 0],
      ['POP'],
      ['HALT'],
    ],
  };
  const out = peepholePass(prog);
  expect(out.code).toEqual([
    ['JUMP', 1],
    ['HALT'],
  ]);
});
