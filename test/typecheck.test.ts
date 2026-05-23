import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check, formatErrors } from '../src/typecheck.js';

function checkSrc(source: string): string[] {
  return check(parse(tokenize(source))).map(e => e.message);
}

// ── No errors ────────────────────────────────────────────────────────────────

test('let + arithmetic: no errors', () => {
  expect(checkSrc('let x = 1 + 2; let y = x * 3;')).toEqual([]);
});

test('string concat: no errors', () => {
  expect(checkSrc('let s = "hi " + "world";')).toEqual([]);
});

test('comparison returning bool, if branches: no errors', () => {
  expect(checkSrc('if (1 < 2) { 10 } else { 20 };')).toEqual([]);
});

test('fn declaration + call: no errors', () => {
  expect(checkSrc('let id = fn(x) { x }; id(5);')).toEqual([]);
});

test('builtin calls: no errors', () => {
  expect(checkSrc('print(to_str(now()));')).toEqual([]);
});

test('list/dict builtins: no errors', () => {
  expect(checkSrc('let xs = list_new(1, 2); let n = list_get(xs, 0);')).toEqual([]);
});

// ── Error cases ──────────────────────────────────────────────────────────────

test('mixing int + str in binop is an error', () => {
  const errs = checkSrc('let x = 1 + "two";');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/binop '\+' requires/);
});

test('if condition non-bool is an error', () => {
  const errs = checkSrc('if (1) { 2 } else { 3 };');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/if condition must be bool/);
});

test('undefined variable in scope is an error', () => {
  const errs = checkSrc('let x = unknown_var;');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/undefined variable 'unknown_var'/);
});

test('arity mismatch on builtin', () => {
  const errs = checkSrc('str_length();');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/expected 1 args, got 0/);
});

test('wrong arg type to builtin', () => {
  const errs = checkSrc('str_length(42);');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/arg 1 expected str, got int/);
});

test('calling non-function is an error', () => {
  const errs = checkSrc('let x = 1; x(2);');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/callee is int, not a function/);
});

test('comparison between mismatched types is an error', () => {
  const errs = checkSrc('let b = 1 == "hello";');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/binop '==' type mismatch/);
});

test('errors include line:col when AST has positions', () => {
  const errs = check(parse(tokenize('let x = 1;\nlet y = 1 + "two";')));
  expect(errs.length).toBe(1);
  expect(errs[0].pos?.line).toBe(2);
});

test('formatErrors renders position', () => {
  const errs = check(parse(tokenize('let x = 1 + "two";')));
  const text = formatErrors(errs);
  expect(text).toMatch(/type error.*at line 1/);
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test('closure parameter is unknown — call site is not type-checked', () => {
  // The fn takes `x: unknown`; calling with int doesn't error even if body expects str.
  // This is conservative — pragmatic for an MVP type checker.
  expect(checkSrc('let f = fn(x) { x + 1 }; f("hello");')).toEqual([]);
});

test('multiple errors are all reported', () => {
  const errs = checkSrc('let x = 1 + "a"; let y = "b" * 2;');
  expect(errs.length).toBeGreaterThanOrEqual(2);
});
