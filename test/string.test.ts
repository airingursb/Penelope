import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { runToCompletion } from '../src/legacy-interpreter.js';

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

test('A5: str_length returns int length', () => {
  const ast = parse(tokenize('str_length("hello");'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error('expected done');
  expect(result.finalValue).toEqual({ tag: 'int', v: 5 });
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

test('A6: str_slice basic', () => {
  const ast = parse(tokenize('str_slice("hello", 1, 4);'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error('expected done');
  expect(result.finalValue).toEqual({ tag: 'str', v: 'ell' });
});

test('A7: str_slice edge cases (empty, full, OOB clipped)', () => {
  function evalSlice(src: string): string {
    const ast = parse(tokenize(src));
    const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
    if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
    const r = runToCompletion(ast, stmt.exprId);
    if (r.kind !== 'done') throw new Error('expected done');
    if (!r.finalValue || r.finalValue.tag !== 'str') throw new Error('expected str');
    return r.finalValue.v;
  }
  expect(evalSlice('str_slice("hello", 0, 0);')).toBe('');
  expect(evalSlice('str_slice("hello", 0, 5);')).toBe('hello');
  expect(evalSlice('str_slice("hello", 2, 100);')).toBe('llo');
  expect(evalSlice('str_slice("hello", 0 - 2, 3);')).toBe('hel');
});

test('A11: to_str on each Value tag', () => {
  const ast = parse(tokenize('print(to_str(42)); print(to_str(true)); print(to_str(false));'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['42', 'true', 'false']);
  } finally { console.log = origLog; }
});

test('A12: to_str + concat in real use', () => {
  const ast = parse(tokenize('print("amount: " + to_str(5000));'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['amount: 5000']);
  } finally { console.log = origLog; }
});
