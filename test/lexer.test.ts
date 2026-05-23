import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';

test('empty source produces a single EOF token', () => {
  const tokens = tokenize('');
  expect(tokens).toEqual([
    { kind: 'EOF', line: 1, col: 1 },
  ]);
});

test('tokenizes positive integers', () => {
  const tokens = tokenize('42');
  expect(tokens).toEqual([
    { kind: 'INT', line: 1, col: 1, value: 42 },
    { kind: 'EOF', line: 1, col: 3 },
  ]);
});

test('tokenizes multi-digit integers', () => {
  const tokens = tokenize('100 7');
  expect(tokens[0]).toMatchObject({ kind: 'INT', value: 100 });
  expect(tokens[1]).toMatchObject({ kind: 'INT', value: 7 });
});

test('tokenizes identifiers', () => {
  const tokens = tokenize('foo bar_baz x1');
  expect(tokens[0]).toMatchObject({ kind: 'IDENT', text: 'foo' });
  expect(tokens[1]).toMatchObject({ kind: 'IDENT', text: 'bar_baz' });
  expect(tokens[2]).toMatchObject({ kind: 'IDENT', text: 'x1' });
});

test('tokenizes keywords', () => {
  const src = 'let fn if else true false pause print';
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual(['LET','FN','IF','ELSE','TRUE','FALSE','PAUSE','PRINT','EOF']);
});

test('keywords are not identifiers', () => {
  const tokens = tokenize('let x');
  expect(tokens[0].kind).toBe('LET');
  expect(tokens[1]).toMatchObject({ kind: 'IDENT', text: 'x' });
});
