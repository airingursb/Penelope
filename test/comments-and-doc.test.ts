import { test, expect } from 'vitest';
import { tokenize, tokenizeWithComments } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { format } from '../src/format.js';
import { extractDocs, renderMarkdown } from '../src/doc-gen.js';

// ── Lexer: comment extraction ────────────────────────────────────────────────

test('tokenize() still returns only tokens (no breaking change)', () => {
  const ts = tokenize('let x = 1;');
  expect(ts[ts.length - 1].kind).toBe('EOF');
});

test('tokenizeWithComments returns regular comments separately', () => {
  const { tokens, comments } = tokenizeWithComments('// hi\nlet x = 1;');
  expect(tokens[0].kind).toBe('LET');
  expect(comments).toEqual([{ line: 1, col: 1, text: 'hi', doc: false }]);
});

test('/// is recognized as a doc comment', () => {
  const { comments } = tokenizeWithComments('/// docs\nlet x = 1;');
  expect(comments).toEqual([{ line: 1, col: 1, text: 'docs', doc: true }]);
});

// ── Format: comments survive ─────────────────────────────────────────────────

test('format with comments preserves them in source order', () => {
  const src = '// header\nlet x = 1;\n// before y\nlet y = 2;';
  const { tokens, comments } = tokenizeWithComments(src);
  const ast = parse(tokens);
  const out = format(ast, { comments });
  expect(out).toContain('// header');
  expect(out).toContain('// before y');
  expect(out.indexOf('// header')).toBeLessThan(out.indexOf('let x'));
  expect(out.indexOf('// before y')).toBeLessThan(out.indexOf('let y'));
});

test('format without comments option (default) drops them', () => {
  const src = '// dropped\nlet x = 1;';
  const ast = parse(tokenize(src));
  const out = format(ast);
  expect(out).not.toContain('// dropped');
});

// ── pen doc: extraction ──────────────────────────────────────────────────────

test('extractDocs picks up /// on let fn', () => {
  const src = '/// my docs\nlet f = fn(x) { x };';
  const { tokens, comments } = tokenizeWithComments(src);
  const entries = extractDocs(parse(tokens), comments);
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe('f');
  expect(entries[0].kind).toBe('fn');
  expect(entries[0].signature).toBe('fn(x)');
  expect(entries[0].doc).toBe('my docs');
});

test('extractDocs concatenates multi-line /// comments', () => {
  const src = '/// line 1\n/// line 2\nlet x = 1;';
  const { tokens, comments } = tokenizeWithComments(src);
  const entries = extractDocs(parse(tokens), comments);
  expect(entries[0].doc).toBe('line 1\nline 2');
});

test('extractDocs skips lets without preceding ///', () => {
  const src = 'let x = 1;\n/// doc\nlet y = 2;';
  const { tokens, comments } = tokenizeWithComments(src);
  const entries = extractDocs(parse(tokens), comments);
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toBe('y');
});

test('extractDocs ignores // regular comments', () => {
  const src = '// not a doc\nlet x = 1;';
  const { tokens, comments } = tokenizeWithComments(src);
  expect(extractDocs(parse(tokens), comments)).toEqual([]);
});

test('renderMarkdown produces a heading per entry', () => {
  const md = renderMarkdown('foo.pen', [
    { name: 'double', kind: 'fn', line: 3, signature: 'fn(x)', doc: 'doubles' },
    { name: 'g', kind: 'value', line: 5, doc: 'a greeting' },
  ]);
  expect(md).toContain('# `foo.pen`');
  expect(md).toContain('## `double(x)`');
  expect(md).toContain('## `g`');
  expect(md).toContain('doubles');
  expect(md).toContain('a greeting');
});

test('renderMarkdown handles empty entries', () => {
  expect(renderMarkdown('empty.pen', [])).toContain('No `///` doc comments found');
});
