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

test('parses let statement', () => {
  const ast = parse(tokenize('let x = 42;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'Let') throw new Error('expected Let');
  expect(stmt.name).toBe('x');
  expect(ast.nodes[stmt.valueId]).toMatchObject({ kind: 'IntLit', value: 42 });
});

test('parses print statement', () => {
  const ast = parse(tokenize('print(x + 1);'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'Print') throw new Error('expected Print');
  const arg = ast.nodes[stmt.argId];
  expect(arg.kind).toBe('BinOp');
});

test('parses multiple top-level statements in order', () => {
  const ast = parse(tokenize('let x = 1; print(x);'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  expect(program.stmtIds.length).toBe(2);
  expect(ast.nodes[program.stmtIds[0]].kind).toBe('Let');
  expect(ast.nodes[program.stmtIds[1]].kind).toBe('Print');
});

test('parses a function literal', () => {
  const ast = parse(tokenize('let f = fn(x, y) { x + y };'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const letStmt = ast.nodes[program.stmtIds[0]];
  if (letStmt.kind !== 'Let') throw new Error('expected Let');
  const fn = ast.nodes[letStmt.valueId];
  if (fn.kind !== 'Fn') throw new Error('expected Fn');
  expect(fn.params).toEqual(['x', 'y']);

  const body = ast.nodes[fn.bodyBlockId];
  if (body.kind !== 'Block') throw new Error('expected Block');
  expect(body.stmtIds).toEqual([]);
  expect(body.trailingExprId).not.toBeNull();
});

test('parses a function call', () => {
  const ast = parse(tokenize('f(1, 2);'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  const call = ast.nodes[stmt.exprId];
  if (call.kind !== 'Call') throw new Error('expected Call');
  expect(call.argIds.length).toBe(2);
});

test('parses a block with statements and a trailing expression', () => {
  const ast = parse(tokenize('let f = fn() { let a = 1; a + 2 };'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const letStmt = ast.nodes[program.stmtIds[0]];
  if (letStmt.kind !== 'Let') throw new Error('expected Let');
  const fn = ast.nodes[letStmt.valueId];
  if (fn.kind !== 'Fn') throw new Error('expected Fn');
  const block = ast.nodes[fn.bodyBlockId];
  if (block.kind !== 'Block') throw new Error('expected Block');
  expect(block.stmtIds.length).toBe(1);
  expect(block.trailingExprId).not.toBeNull();
});

test('parses a block with no trailing expression (unit-valued)', () => {
  const ast = parse(tokenize('let f = fn() { let a = 1; };'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const letStmt = ast.nodes[program.stmtIds[0]];
  if (letStmt.kind !== 'Let') throw new Error('expected Let');
  const fn = ast.nodes[letStmt.valueId];
  if (fn.kind !== 'Fn') throw new Error('expected Fn');
  const block = ast.nodes[fn.bodyBlockId];
  if (block.kind !== 'Block') throw new Error('expected Block');
  expect(block.stmtIds.length).toBe(1);
  expect(block.trailingExprId).toBeNull();
});

test('parses if/else expression', () => {
  const ast = parse(tokenize('let x = if (true) { 1 } else { 2 };'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const letStmt = ast.nodes[program.stmtIds[0]];
  if (letStmt.kind !== 'Let') throw new Error('expected Let');
  const ifExpr = ast.nodes[letStmt.valueId];
  if (ifExpr.kind !== 'If') throw new Error('expected If');
  expect(ast.nodes[ifExpr.condId]).toMatchObject({ kind: 'BoolLit', value: true });
  expect(ast.nodes[ifExpr.thenBlockId].kind).toBe('Block');
  expect(ast.nodes[ifExpr.elseBlockId].kind).toBe('Block');
});

test('parsing the same source twice produces identical NodeId assignments', () => {
  const src = `
    let x = 10;
    let f = fn(a, b) {
      if (a < b) { a + 1 } else { b * 2 }
    };
    print(f(x, 20));
  `;
  const ast1 = parse(tokenize(src));
  const ast2 = parse(tokenize(src));

  // Same root id
  expect(ast1.rootId).toBe(ast2.rootId);

  // Same set of node ids
  expect(Object.keys(ast1.nodes).sort()).toEqual(Object.keys(ast2.nodes).sort());

  // Same content per id
  for (const id of Object.keys(ast1.nodes)) {
    expect(ast1.nodes[id]).toEqual(ast2.nodes[id]);
  }
});

test('parsing different source produces different node id sets', () => {
  const a = parse(tokenize('let x = 1;'));
  const b = parse(tokenize('let x = 1; let y = 2;'));
  expect(Object.keys(a.nodes).length).toBeLessThan(Object.keys(b.nodes).length);
});
