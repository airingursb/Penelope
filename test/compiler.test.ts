// test/compiler.test.ts
import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';

test('empty program compiles to just HALT', () => {
  const ast = parse(tokenize(''));
  const prog = compile(ast);
  expect(prog.version).toBe(1);
  expect(prog.code).toEqual([['HALT']]);
  expect(prog.constants).toEqual([]);
});

test('"42;" compiles to LOAD_CONST 0; POP; HALT with constants=[int 42]', () => {
  const ast = parse(tokenize('42;'));
  const prog = compile(ast);
  expect(prog.constants).toEqual([{ tag: 'int', v: 42 }]);
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['POP'],
    ['HALT'],
  ]);
});
