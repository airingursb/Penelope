import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

test('parses empty program', () => {
  const ast = parse(tokenize(''));
  expect(ast.nodes[ast.rootId]).toMatchObject({ kind: 'Program', stmtIds: [] });
});

test('parses an int-literal expression statement', () => {
  const ast = parse(tokenize('42;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'IntLit', value: 42 });
});

test('parses a boolean literal', () => {
  const ast = parse(tokenize('true;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'BoolLit', value: true });
});

test('parses a variable reference', () => {
  const ast = parse(tokenize('x;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'Var', name: 'x' });
});

test('parses pause expression', () => {
  const ast = parse(tokenize('pause;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'Pause' });
});

test('parses addition', () => {
  const ast = parse(tokenize('1 + 2;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  const bin = ast.nodes[stmt.exprId];
  expect(bin).toMatchObject({ kind: 'BinOp', op: '+' });
});

test('respects precedence: 1 + 2 * 3', () => {
  const ast = parse(tokenize('1 + 2 * 3;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  const top = ast.nodes[stmt.exprId];
  if (top.kind !== 'BinOp') throw new Error('expected BinOp');
  expect(top.op).toBe('+');
  expect(ast.nodes[top.leftId]).toMatchObject({ kind: 'IntLit', value: 1 });
  const right = ast.nodes[top.rightId];
  if (right.kind !== 'BinOp') throw new Error('expected BinOp on right');
  expect(right.op).toBe('*');
});

test('parses comparison', () => {
  const ast = parse(tokenize('x < 10;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'BinOp', op: '<' });
});
