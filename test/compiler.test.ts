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

test('"true;" compiles', () => {
  const prog = compile(parse(tokenize('true;')));
  expect(prog.constants).toEqual([{ tag: 'bool', v: true }]);
  expect(prog.code).toEqual([['LOAD_CONST', 0], ['POP'], ['HALT']]);
});

test('"false;" compiles', () => {
  const prog = compile(parse(tokenize('false;')));
  expect(prog.constants).toEqual([{ tag: 'bool', v: false }]);
});

test('StringLit compiles', () => {
  const prog = compile(parse(tokenize('"hello";')));
  expect(prog.constants).toEqual([{ tag: 'str', v: 'hello' }]);
  expect(prog.code).toEqual([['LOAD_CONST', 0], ['POP'], ['HALT']]);
});

test('repeated string literals share one constant pool entry', () => {
  const prog = compile(parse(tokenize('"x"; "x"; "y";')));
  expect(prog.constants).toEqual([
    { tag: 'str', v: 'x' },
    { tag: 'str', v: 'y' },
  ]);
  // Three LOAD_CONST opcodes; first two index 0, third index 1.
  const loads = prog.code.filter(op => op[0] === 'LOAD_CONST');
  expect(loads).toEqual([['LOAD_CONST', 0], ['LOAD_CONST', 0], ['LOAD_CONST', 1]]);
});
