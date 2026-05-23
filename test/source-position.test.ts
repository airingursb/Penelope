// Source positions: verify that compiler attaches line:col info to opcodes,
// and that VM errors include line:col when available.

import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { formatPos } from '../src/bytecode.js';

test('compiler populates sourceMap parallel to code', () => {
  const ast = parse(tokenize('let x = 1;'));
  const prog = compile(ast);
  expect(prog.sourceMap).toBeDefined();
  expect(prog.sourceMap!.length).toBe(prog.code.length);
});

test('LOAD_CONST for IntLit 1 records line 1 col 9', () => {
  // "let x = 1;" — IntLit "1" is at col 9
  const ast = parse(tokenize('let x = 1;'));
  const prog = compile(ast);
  const loadConstIp = prog.code.findIndex(op => op[0] === 'LOAD_CONST');
  expect(prog.sourceMap![loadConstIp]).toEqual({ line: 1, col: 9 });
});

test('LOAD_VAR for undefined variable throws with line:col', () => {
  const ast = parse(tokenize('undefined_var;'));
  const prog = compile(ast);
  expect(() => run(prog)).toThrow(/undefined variable 'undefined_var'.*line 1 col 1/);
});

test('positions survive across multiple lines', () => {
  const source = 'let x = 1;\nlet y = 2;\nundefined_var;';
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  expect(() => run(prog)).toThrow(/line 3 col 1/);
});

test('formatPos returns sensible string when sourceMap missing', () => {
  expect(formatPos({ version: 1, constants: [], code: [['HALT']] }, 0)).toBe('ip 0');
});

test('formatPos returns line:col when sourceMap present', () => {
  expect(formatPos({
    version: 1,
    constants: [],
    code: [['HALT']],
    sourceMap: [{ line: 5, col: 3 }],
  }, 0)).toBe('line 5 col 3 (ip 0)');
});

test('CALL arity mismatch error includes line:col', () => {
  const source = 'let f = fn(x) { x }; f();';
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  expect(() => run(prog)).toThrow(/arity mismatch.*line 1/);
});

test('if condition non-bool error includes line:col', () => {
  const source = 'if (1) { 2 } else { 3 };';
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  expect(() => run(prog)).toThrow(/if condition.*line 1/);
});
