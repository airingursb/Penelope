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
