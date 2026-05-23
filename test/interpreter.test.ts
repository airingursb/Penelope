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

test('evaluates 1 + 2 to 3', () => {
  const ast = parse(tokenize('1 + 2;'));
  const top = Object.values(ast.nodes).find(n => n.kind === 'BinOp');
  const result = runToCompletion(ast, top!.id);
  if (result.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(result)}`);
  expect(result.finalValue).toEqual({ tag: 'int', v: 3 });
});

test('respects precedence: 1 + 2 * 3 = 7', () => {
  const ast = parse(tokenize('1 + 2 * 3;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error(`expected done`);
  expect(result.finalValue).toEqual({ tag: 'int', v: 7 });
});

test('division truncates toward zero', () => {
  const ast = parse(tokenize('7 / 2;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error(`expected done`);
  expect(result.finalValue).toEqual({ tag: 'int', v: 3 });
});

test('comparison produces bool', () => {
  const ast = parse(tokenize('1 < 2;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error(`expected done`);
  expect(result.finalValue).toEqual({ tag: 'bool', v: true });
});

test('type mismatch on + is a runtime error', () => {
  const ast = parse(tokenize('1 + true;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  expect(result.kind).toBe('error');
});

test('division by zero is a runtime error', () => {
  const ast = parse(tokenize('1 / 0;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/division by zero/);
});
