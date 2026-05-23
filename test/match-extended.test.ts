import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

function execProgram(source: string) {
  return run(compile(parse(tokenize(source))));
}

// ── Or-patterns ──────────────────────────────────────────────────────────────

test('or-pattern matches first alternative', () => {
  const r = execProgram('let v = match 1 { 1 | 2 | 3 => "small", _ => "big" };');
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'small' });
});

test('or-pattern matches middle alternative', () => {
  const r = execProgram('let v = match 2 { 1 | 2 | 3 => "small", _ => "big" };');
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'small' });
});

test('or-pattern falls through when no alternative matches', () => {
  const r = execProgram('let v = match 99 { 1 | 2 | 3 => "small", _ => "big" };');
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'big' });
});

// ── Guards ───────────────────────────────────────────────────────────────────

test('guard: arm matches only when guard true', () => {
  const r = execProgram('let v = match 50 { n if n > 100 => "big", n if n < 0 => "neg", _ => "ok" };');
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'ok' });
});

test('guard: arm passes when guard true', () => {
  const r = execProgram('let v = match 150 { n if n > 100 => "big", _ => "ok" };');
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'big' });
});

test('guard: bindings from pattern are in scope', () => {
  const r = execProgram('let v = match 7 { n if n * 2 == 14 => n + 1, _ => 0 };');
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'int', v: 8 });
});

// ── List patterns ────────────────────────────────────────────────────────────

test('list pattern: empty list', () => {
  const r = execProgram('let v = match list_new() { [] => "empty", _ => "not" };');
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'empty' });
});

test('list pattern: head + rest', () => {
  const r = execProgram(`
    let v = match list_new(10, 20, 30) {
      [] => 0,
      [h, ...t] => h + list_len(t),
    };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'int', v: 12 });   // 10 + 2
});

test('list pattern: fixed length match', () => {
  const r = execProgram(`
    let v = match list_new(1, 2) {
      [a, b] => a + b,
      _ => 0,
    };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'int', v: 3 });
});

test('list pattern: wrong length fails', () => {
  const r = execProgram(`
    let v = match list_new(1, 2, 3) {
      [a, b] => "two",
      _ => "other",
    };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'other' });
});

test('list pattern: nested patterns', () => {
  const r = execProgram(`
    let v = match list_new(1, 2) {
      [1, x] => x,
      _ => 0,
    };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'int', v: 2 });
});

test('list pattern: type mismatch returns false (not throws)', () => {
  // Pattern check on an int — should fall through to _, not throw.
  const r = execProgram(`
    let v = match 42 {
      [] => "empty list",
      _ => "not a list",
    };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'not a list' });
});

// ── Dict patterns ────────────────────────────────────────────────────────────

test('dict pattern: extract key', () => {
  const r = execProgram(`
    let d = dict_set(dict_new(), "name", "Penelope");
    let v = match d { {name: n} => n, _ => "?" };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'Penelope' });
});

test('dict pattern: missing key falls through', () => {
  const r = execProgram(`
    let d = dict_set(dict_new(), "age", 42);
    let v = match d { {name: n} => n, _ => "no name" };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'no name' });
});

test('dict pattern: multiple keys', () => {
  const r = execProgram(`
    let d = dict_set(dict_set(dict_new(), "x", 1), "y", 2);
    let v = match d { {x: a, y: b} => a + b, _ => 0 };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'int', v: 3 });
});

test('dict pattern: type mismatch falls through', () => {
  const r = execProgram(`
    let v = match 42 { {name: n} => n, _ => "not a dict" };
  `);
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'not a dict' });
});

// ── unit pattern ─────────────────────────────────────────────────────────────

test('unit pattern matches ()', () => {
  const r = execProgram('let v = match () { () => "yes", _ => "no" };');
  expect(r.state.frames[0].bindings.v).toEqual({ tag: 'str', v: 'yes' });
});

// ── type_of builtin (used internally by list/dict patterns) ──────────────────

test('type_of returns tag string', () => {
  const r = execProgram(`
    let a = type_of(42);
    let b = type_of("hi");
    let c = type_of(true);
    let d = type_of(list_new());
    let e = type_of(dict_new());
    let f = type_of(());
  `);
  expect(r.state.frames[0].bindings.a).toEqual({ tag: 'str', v: 'int' });
  expect(r.state.frames[0].bindings.b).toEqual({ tag: 'str', v: 'str' });
  expect(r.state.frames[0].bindings.c).toEqual({ tag: 'str', v: 'bool' });
  expect(r.state.frames[0].bindings.d).toEqual({ tag: 'str', v: 'list' });
  expect(r.state.frames[0].bindings.e).toEqual({ tag: 'str', v: 'dict' });
  expect(r.state.frames[0].bindings.f).toEqual({ tag: 'str', v: 'unit' });
});
