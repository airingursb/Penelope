import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { format } from '../src/format.js';

function fmt(src: string): string {
  return format(parse(tokenize(src)));
}

// ── Basic shapes ─────────────────────────────────────────────────────────────

test('empty program formats to empty', () => {
  expect(fmt('')).toBe('');
});

test('let binding canonical form', () => {
  expect(fmt('let  x=1 ;').trim()).toBe('let x = 1;');
});

test('binop spacing', () => {
  expect(fmt('1+2;').trim()).toBe('1 + 2;');
});

test('binop nesting wraps in parens', () => {
  expect(fmt('1 + 2 * 3;').trim()).toBe('1 + (2 * 3);');
});

test('string literal stays double-quoted', () => {
  expect(fmt('"hello";').trim()).toBe('"hello";');
});

test('if/else single-expression branches stay one-line', () => {
  expect(fmt('if(1<2){10}else{20};').trim()).toBe('if (1 < 2) { 10 } else { 20 };');
});

test('fn definition canonical form', () => {
  expect(fmt('let f=fn(x,y){x+y};').trim()).toBe('let f = fn(x, y) { x + y };');
});

test('Call with multiple args', () => {
  expect(fmt('print(to_str(1+2));').trim()).toBe('print(to_str(1 + 2));');
});

test('multi-statement block indents body', () => {
  const src = 'let f = fn() { let a = 1; let b = 2; a + b };';
  const out = fmt(src);
  expect(out).toContain('fn() {\n  let a = 1;\n  let b = 2;\n  a + b\n}');
});

// ── Idempotency ──────────────────────────────────────────────────────────────

const samples = [
  'let x = 1;',
  '1 + 2 * 3 - 4;',
  'let f = fn(a, b) { a + b }; f(1, 2);',
  'if (1 < 2) { 10 } else { 20 };',
  'let l = list_new(1, 2, 3); print(to_str(l));',
  'let d = dict_set(dict_new(), "k", 1); print(to_str(dict_get(d, "k")));',
  'let g = fn(n) { if (n == 0) { 1 } else { n * g(n - 1) } };',
];

test.each(samples)('format is idempotent on: %s', (src) => {
  const a = fmt(src);
  const b = fmt(a);
  expect(b).toBe(a);
});

// ── Comments are dropped when not passed in (default behavior) ───────────────

test('comments dropped without explicit comments arg', () => {
  const src = '// a comment\nlet x = 1;';
  const out = fmt(src).trim();
  expect(out).toBe('let x = 1;');
});
