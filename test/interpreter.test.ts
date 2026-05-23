import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { runToCompletion } from '../src/interpreter.js';

test('runs an integer literal to completion with the literal on the value stack', () => {
  const ast = parse(tokenize('42;'));
  const intLit = Object.values(ast.nodes).find(n => n.kind === 'IntLit');
  expect(intLit).toBeDefined();
  const result = runToCompletion(ast, intLit!.id);
  if (result.kind !== 'done') throw new Error(`expected done, got ${result.kind}`);
  expect(result.finalValue).toEqual({ tag: 'int', v: 42 });
});

test('runs a boolean literal', () => {
  const ast = parse(tokenize('true;'));
  const lit = Object.values(ast.nodes).find(n => n.kind === 'BoolLit');
  const result = runToCompletion(ast, lit!.id);
  if (result.kind !== 'done') throw new Error(`expected done`);
  expect(result.finalValue).toEqual({ tag: 'bool', v: true });
});
