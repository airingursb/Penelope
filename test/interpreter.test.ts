import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { runToCompletion, step } from '../src/interpreter.js';

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

test('let + arithmetic + reference works', () => {
  const ast = parse(tokenize('let x = 10; let y = 5; x + y;'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('done');
});

test('print writes to stdout (captured via spy)', () => {
  const ast = parse(tokenize('print(1 + 2);'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['3']);
  } finally {
    console.log = origLog;
  }
});

test('undefined variable is a runtime error', () => {
  const ast = parse(tokenize('x;'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/undefined variable 'x'/);
});

test('a fn body block evaluates to its trailing expression (via if)', () => {
  const ast = parse(tokenize('print(if (true) { 1 + 2 } else { 99 });'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['3']);
  } finally {
    console.log = origLog;
  }
});

test('a block with no trailing expression evaluates to unit', () => {
  const ast = parse(tokenize('print(if (true) { } else { });'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['()']);
  } finally {
    console.log = origLog;
  }
});

test('block scope isolates lets', () => {
  const ast = parse(tokenize(`
    print(if (true) { let x = 99; x } else { 0 });
  `));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['99']);
  } finally {
    console.log = origLog;
  }
});

test('fn definition and call', () => {
  const ast = parse(tokenize(`
    let add = fn(a, b) { a + b };
    print(add(2, 3));
  `));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['5']);
  } finally {
    console.log = origLog;
  }
});

test('lexical closure captures outer scope', () => {
  const ast = parse(tokenize(`
    let outer = fn() {
      let a = 100;
      let inner = fn() { a + 1 };
      inner()
    };
    print(outer());
  `));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['101']);
  } finally {
    console.log = origLog;
  }
});

test('arg-count mismatch is a runtime error', () => {
  const ast = parse(tokenize('let f = fn(a) { a }; f(1, 2);'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/expected 1 args, got 2/);
});

test('calling a non-function is a runtime error', () => {
  const ast = parse(tokenize('let x = 1; x(5);'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/not callable/);
});

test('pause halts the loop with a snapshot', () => {
  const ast = parse(tokenize('let x = pause; x + 1;'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('paused');
  if (result.kind === 'paused') {
    expect(typeof result.pausedAt).toBe('string');
    // After pause, the bindLet for x is still pending on control.
    expect(result.state.control.length).toBeGreaterThan(0);
  }
});

test('resume by pushing a value to valueStack and continuing', () => {
  const ast = parse(tokenize('let x = pause; print(x + 1);'));
  const paused = runToCompletion(ast);
  if (paused.kind !== 'paused') throw new Error(`expected paused`);

  const resumedState = {
    ...paused.state,
    valueStack: [...paused.state.valueStack, { tag: 'int' as const, v: 41 }],
  };

  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    let s = resumedState;
    while (true) {
      const r = step(s, ast);
      if (r.kind === 'continue') { s = r.state; continue; }
      expect(r.kind).toBe('done');
      break;
    }
    expect(logged).toEqual(['42']);
  } finally {
    console.log = origLog;
  }
});
