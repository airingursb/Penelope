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
  const src = 'let fn if else true false pause';
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual(['LET','FN','IF','ELSE','TRUE','FALSE','PAUSE','EOF']);
});

test('print is an identifier (not a keyword)', () => {
  const tokens = tokenize('print');
  expect(tokens[0]).toMatchObject({ kind: 'IDENT', text: 'print' });
});

test('keywords are not identifiers', () => {
  const tokens = tokenize('let x');
  expect(tokens[0].kind).toBe('LET');
  expect(tokens[1]).toMatchObject({ kind: 'IDENT', text: 'x' });
});

test('tokenizes single-char operators and punctuation', () => {
  const src = '+ - * / < > = ( ) { } , ;';
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual([
    'PLUS','MINUS','STAR','SLASH','LT','GT','EQ',
    'LPAREN','RPAREN','LBRACE','RBRACE','COMMA','SEMI','EOF',
  ]);
});

test('tokenizes two-char operators', () => {
  const src = '<= >= == !=';
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual(['LE','GE','EQ_EQ','BANG_EQ','EOF']);
});

test('disambiguates < from <=', () => {
  const kinds = tokenize('< <=').map(t => t.kind);
  expect(kinds).toEqual(['LT','LE','EOF']);
});

test('skips line comments', () => {
  const src = `// this is a comment
let x = 1;`;
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual(['LET','IDENT','EQ','INT','SEMI','EOF']);
});

test('comment to end of file is OK', () => {
  const src = '42 // trailing comment, no newline';
  const tokens = tokenize(src);
  expect(tokens[0]).toMatchObject({ kind: 'INT', value: 42 });
  expect(tokens[1].kind).toBe('EOF');
});

test('does not treat / not followed by / as a comment', () => {
  expect(tokenize('1 / 2')[1].kind).toBe('SLASH');
});

test('throws on unexpected characters', () => {
  expect(() => tokenize('@')).toThrow(/unexpected character/);
});

test('tokenizes a simple string literal', () => {
  const tokens = tokenize('"hello"');
  expect(tokens[0]).toMatchObject({ kind: 'STRING', text: 'hello' });
  expect(tokens[1].kind).toBe('EOF');
});

test('handles string escape sequences', () => {
  expect(tokenize('"a\\nb"')[0]).toMatchObject({ kind: 'STRING', text: 'a\nb' });
  expect(tokenize('"a\\\\b"')[0]).toMatchObject({ kind: 'STRING', text: 'a\\b' });
  expect(tokenize('"a\\"b"')[0]).toMatchObject({ kind: 'STRING', text: 'a"b' });
});

test('empty string literal', () => {
  expect(tokenize('""')[0]).toMatchObject({ kind: 'STRING', text: '' });
});

test('unterminated string throws', () => {
  expect(() => tokenize('"hello')).toThrow(/unterminated string/);
});
