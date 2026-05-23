import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { runToCompletion } from '../src/interpreter.js';

test('A1: string literal parses to StringLit', () => {
  const ast = parse(tokenize('"hello";'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'StringLit', value: 'hello' });
});

test('A2: string literal evaluates to str Value', () => {
  const ast = parse(tokenize('"hello";'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error('expected done');
  expect(result.finalValue).toEqual({ tag: 'str', v: 'hello' });
});

test('A9: print prints a string without quotes', () => {
  const ast = parse(tokenize('print("hello");'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['hello']);
  } finally { console.log = origLog; }
});

test('A3: string + string concat', () => {
  const ast = parse(tokenize('"abc" + "def";'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error('expected done');
  expect(result.finalValue).toEqual({ tag: 'str', v: 'abcdef' });
});

test('A10: int + str is a runtime error', () => {
  const ast = parse(tokenize('1 + "a";'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/cannot apply/);
});

test('A4: string equality (== and !=)', () => {
  const ast1 = parse(tokenize('"a" == "a";'));
  const s1 = Object.values(ast1.nodes).find(n => n.kind === 'ExprStmt');
  if (!s1 || s1.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const r1 = runToCompletion(ast1, s1.exprId);
  if (r1.kind !== 'done') throw new Error('expected done');
  expect(r1.finalValue).toEqual({ tag: 'bool', v: true });

  const ast2 = parse(tokenize('"a" != "b";'));
  const s2 = Object.values(ast2.nodes).find(n => n.kind === 'ExprStmt');
  if (!s2 || s2.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const r2 = runToCompletion(ast2, s2.exprId);
  if (r2.kind !== 'done') throw new Error('expected done');
  expect(r2.finalValue).toEqual({ tag: 'bool', v: true });
});
