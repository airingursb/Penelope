import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { loadSource } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function execProgram(source: string) {
  return run(compile(parse(tokenize(source))));
}

function execWithImports(mainSrc: string): ReturnType<typeof run> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-std-'));
  const mainPath = path.join(dir, 'main.pen');
  writeFileSync(mainPath, mainSrc);
  try {
    const fullSrc = loadSource(mainPath);
    return run(compile(parse(tokenize(fullSrc))));
  } finally {
    rmSync(dir, { recursive: true });
  }
}

// ── String introspection ─────────────────────────────────────────────────────

test('str_chars splits into single-char list', () => {
  const r = execProgram('let cs = str_chars("hi");');
  expect(r.state.frames[0].bindings.cs).toEqual({
    tag: 'list',
    items: [{ tag: 'str', v: 'h' }, { tag: 'str', v: 'i' }],
  });
});

test('str_at returns single character', () => {
  const r = execProgram('let c = str_at("hello", 1);');
  expect(r.state.frames[0].bindings.c).toEqual({ tag: 'str', v: 'e' });
});

test('str_at out-of-bounds throws', () => {
  expect(() => execProgram('str_at("hi", 10);')).toThrow(/out of bounds/);
});

test('str_find returns index of substring', () => {
  const r = execProgram('let i = str_find("hello world", "world");');
  expect(r.state.frames[0].bindings.i).toEqual({ tag: 'int', v: 6 });
});

test('str_find returns -1 when not found', () => {
  const r = execProgram('let i = str_find("hello", "xyz");');
  expect(r.state.frames[0].bindings.i).toEqual({ tag: 'int', v: -1 });
});

test('str_starts_with / str_ends_with', () => {
  const r = execProgram(`
    let a = str_starts_with("hello", "he");
    let b = str_starts_with("hello", "no");
    let c = str_ends_with("hello", "lo");
  `);
  expect(r.state.frames[0].bindings.a).toEqual({ tag: 'bool', v: true });
  expect(r.state.frames[0].bindings.b).toEqual({ tag: 'bool', v: false });
  expect(r.state.frames[0].bindings.c).toEqual({ tag: 'bool', v: true });
});

test('int_of_str parses decimals', () => {
  const r = execProgram('let n = int_of_str("42");');
  expect(r.state.frames[0].bindings.n).toEqual({ tag: 'int', v: 42 });
});

test('int_of_str parses negative', () => {
  const r = execProgram('let n = int_of_str("-7");');
  expect(r.state.frames[0].bindings.n).toEqual({ tag: 'int', v: -7 });
});

test('int_of_str throws on non-digit', () => {
  expect(() => execProgram('int_of_str("abc");')).toThrow(/not an integer/);
});

// ── List helpers ─────────────────────────────────────────────────────────────

test('list_concat joins two lists', () => {
  const r = execProgram('let r = list_concat(list_new(1, 2), list_new(3, 4));');
  expect(r.state.frames[0].bindings.r).toEqual({
    tag: 'list',
    items: [
      { tag: 'int', v: 1 }, { tag: 'int', v: 2 },
      { tag: 'int', v: 3 }, { tag: 'int', v: 4 },
    ],
  });
});

test('list_reverse', () => {
  const r = execProgram('let r = list_reverse(list_new(1, 2, 3));');
  expect((r.state.frames[0].bindings.r as { tag: 'list'; items: any[] }).items).toEqual([
    { tag: 'int', v: 3 }, { tag: 'int', v: 2 }, { tag: 'int', v: 1 },
  ]);
});

// ── Char predicates ──────────────────────────────────────────────────────────

test('char_is_digit', () => {
  const r = execProgram(`
    let a = char_is_digit("5");
    let b = char_is_digit("a");
    let c = char_is_digit("9");
  `);
  expect(r.state.frames[0].bindings.a).toEqual({ tag: 'bool', v: true });
  expect(r.state.frames[0].bindings.b).toEqual({ tag: 'bool', v: false });
  expect(r.state.frames[0].bindings.c).toEqual({ tag: 'bool', v: true });
});

test('char_is_alpha includes underscore', () => {
  const r = execProgram(`
    let a = char_is_alpha("z");
    let b = char_is_alpha("_");
    let c = char_is_alpha("5");
  `);
  expect(r.state.frames[0].bindings.a).toEqual({ tag: 'bool', v: true });
  expect(r.state.frames[0].bindings.b).toEqual({ tag: 'bool', v: true });
  expect(r.state.frames[0].bindings.c).toEqual({ tag: 'bool', v: false });
});

test('char_is_whitespace covers space/tab/newline', () => {
  const r = execProgram(`
    let a = char_is_whitespace(" ");
    let b = char_is_whitespace("\\t");
    let c = char_is_whitespace("x");
  `);
  expect(r.state.frames[0].bindings.a).toEqual({ tag: 'bool', v: true });
  expect(r.state.frames[0].bindings.b).toEqual({ tag: 'bool', v: true });
  expect(r.state.frames[0].bindings.c).toEqual({ tag: 'bool', v: false });
});

// ── panic ────────────────────────────────────────────────────────────────────

test('panic throws with message', () => {
  expect(() => execProgram('panic("nope");')).toThrow(/panic: nope/);
});

// ── std/iter.pen (higher-order helpers written in Penelope) ──────────────────

test('std/iter.pen list_map works', () => {
  const r = execWithImports(`
    import "${process.cwd()}/std/iter.pen";
    let xs = list_new(1, 2, 3);
    let doubled = list_map(xs, fn(n) { n * 2 });
  `);
  expect((r.state.frames[0].bindings.doubled as { items: any[] }).items).toEqual([
    { tag: 'int', v: 2 }, { tag: 'int', v: 4 }, { tag: 'int', v: 6 },
  ]);
});

test('std/iter.pen list_reduce computes sum', () => {
  const r = execWithImports(`
    import "${process.cwd()}/std/iter.pen";
    let xs = list_range(1, 11);
    let s = list_reduce(xs, 0, fn(acc, x) { acc + x });
  `);
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'int', v: 55 });
});

test('std/iter.pen list_filter keeps matching', () => {
  const r = execWithImports(`
    import "${process.cwd()}/std/iter.pen";
    let xs = list_new(1, 2, 3, 4, 5);
    let evens = list_filter(xs, fn(n) { n / 2 * 2 == n });
  `);
  expect((r.state.frames[0].bindings.evens as { items: any[] }).items).toEqual([
    { tag: 'int', v: 2 }, { tag: 'int', v: 4 },
  ]);
});
