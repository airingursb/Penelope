import { test, expect } from 'vitest';
import { constFoldPass } from '../src/optimizer/constfold.js';
import type { Program } from '../src/bytecode.js';

// T32: basic int arithmetic folding

test('1 + 2 folds to a single LOAD_CONST 3', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  const out = constFoldPass(prog);
  // After fold: LOAD_CONST <3>, HALT. The constant pool may grow.
  expect(out.code.length).toBe(2);
  expect(out.code[0][0]).toBe('LOAD_CONST');
  const idx = (out.code[0] as ['LOAD_CONST', number])[1];
  expect(out.constants[idx]).toEqual({ tag: 'int', v: 3 });
  expect(out.code[1]).toEqual(['HALT']);
});

test('1 + 2 * 3 folds completely', () => {
  // LOAD 1, LOAD 2, LOAD 3, BIN_OP *, BIN_OP +, HALT  → LOAD 7, HALT
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }, { tag: 'int', v: 3 }],
    code: [
      ['LOAD_CONST', 0], ['LOAD_CONST', 1], ['LOAD_CONST', 2],
      ['BIN_OP', '*'], ['BIN_OP', '+'], ['HALT'],
    ],
  };
  const out = constFoldPass(prog);
  expect(out.code.length).toBe(2);
  const v = out.constants[(out.code[0] as ['LOAD_CONST', number])[1]];
  expect(v).toEqual({ tag: 'int', v: 7 });
});

test('LOAD_VAR + LOAD_CONST is not foldable', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['LOAD_VAR', 'x', null], ['LOAD_CONST', 0], ['BIN_OP', '+'], ['HALT']],
  };
  const out = constFoldPass(prog);
  expect(out.code).toEqual(prog.code);
});

// T33: string concat, comparisons, edge cases

test('string concat folds', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hi ' }, { tag: 'str', v: 'world' }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  const out = constFoldPass(prog);
  const v = out.constants[(out.code[0] as ['LOAD_CONST', number])[1]];
  expect(v).toEqual({ tag: 'str', v: 'hi world' });
});

test('comparison folds to bool', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '<'], ['HALT']],
  };
  const out = constFoldPass(prog);
  const v = out.constants[(out.code[0] as ['LOAD_CONST', number])[1]];
  expect(v).toEqual({ tag: 'bool', v: true });
});

test('divide by zero is NOT folded (preserves runtime error)', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 5 }, { tag: 'int', v: 0 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '/'], ['HALT']],
  };
  const out = constFoldPass(prog);
  expect(out.code).toEqual(prog.code);
});

test('mixed-type BIN_OP not folded (preserves runtime error)', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'str', v: 'x' }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  expect(constFoldPass(prog).code).toEqual(prog.code);
});
