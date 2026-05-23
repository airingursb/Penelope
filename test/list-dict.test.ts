import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

function execProgram(source: string) {
  return run(compile(parse(tokenize(source))));
}

// ── list ─────────────────────────────────────────────────────────────────────

test('list_new with elements', () => {
  const r = execProgram('let xs = list_new(1, 2, 3); print(to_str(xs));');
  expect(r.state.effects[0].recordedValue).toEqual({ tag: 'unit' });
});

test('list_get retrieves element by index', () => {
  const r = execProgram('let xs = list_new(10, 20, 30); let y = list_get(xs, 1); print(to_str(y));');
  // The first effect (print) was called with "20"
  expect(r.state.frames[0].bindings.y).toEqual({ tag: 'int', v: 20 });
});

test('list_push returns new list (immutable)', () => {
  const r = execProgram(`
    let a = list_new(1);
    let b = list_push(a, 2);
    let lenA = list_len(a);
    let lenB = list_len(b);
  `);
  expect(r.state.frames[0].bindings.lenA).toEqual({ tag: 'int', v: 1 });
  expect(r.state.frames[0].bindings.lenB).toEqual({ tag: 'int', v: 2 });
});

test('list_set returns new list with updated element', () => {
  const r = execProgram(`
    let a = list_new(1, 2, 3);
    let b = list_set(a, 1, 99);
    let unchanged = list_get(a, 1);
    let changed = list_get(b, 1);
  `);
  expect(r.state.frames[0].bindings.unchanged).toEqual({ tag: 'int', v: 2 });
  expect(r.state.frames[0].bindings.changed).toEqual({ tag: 'int', v: 99 });
});

test('list_get out-of-bounds throws', () => {
  expect(() => execProgram('let xs = list_new(1); list_get(xs, 5);')).toThrow(/out of bounds/);
});

test('list equality is structural', () => {
  const r = execProgram(`
    let a = list_new(1, 2, 3);
    let b = list_new(1, 2, 3);
    let c = list_new(1, 2, 4);
    let eq_same = a == b;
    let eq_diff = a == c;
  `);
  expect(r.state.frames[0].bindings.eq_same).toEqual({ tag: 'bool', v: true });
  expect(r.state.frames[0].bindings.eq_diff).toEqual({ tag: 'bool', v: false });
});

test('to_str on list prints comma-separated', () => {
  const r = execProgram('let xs = list_new(1, 2, 3); let s = to_str(xs);');
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: '[1, 2, 3]' });
});

// ── dict ─────────────────────────────────────────────────────────────────────

test('dict_new creates empty dict', () => {
  const r = execProgram('let d = dict_new(); let s = to_str(d);');
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: '{}' });
});

test('dict_set + dict_get roundtrip', () => {
  const r = execProgram(`
    let d = dict_set(dict_new(), "name", "Penelope");
    let n = dict_get(d, "name");
  `);
  expect(r.state.frames[0].bindings.n).toEqual({ tag: 'str', v: 'Penelope' });
});

test('dict_has true/false', () => {
  const r = execProgram(`
    let d = dict_set(dict_new(), "k", 1);
    let yes = dict_has(d, "k");
    let no = dict_has(d, "missing");
  `);
  expect(r.state.frames[0].bindings.yes).toEqual({ tag: 'bool', v: true });
  expect(r.state.frames[0].bindings.no).toEqual({ tag: 'bool', v: false });
});

test('dict_set returns new dict (immutable)', () => {
  const r = execProgram(`
    let a = dict_set(dict_new(), "k", 1);
    let b = dict_set(a, "k", 2);
    let va = dict_get(a, "k");
    let vb = dict_get(b, "k");
  `);
  expect(r.state.frames[0].bindings.va).toEqual({ tag: 'int', v: 1 });
  expect(r.state.frames[0].bindings.vb).toEqual({ tag: 'int', v: 2 });
});

test('dict_keys returns sorted list of strings', () => {
  const r = execProgram(`
    let d = dict_set(dict_set(dict_set(dict_new(), "c", 3), "a", 1), "b", 2);
    let ks = dict_keys(d);
    let s = to_str(ks);
  `);
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: '["a", "b", "c"]' });
});

test('dict_get on missing key throws', () => {
  expect(() => execProgram('dict_get(dict_new(), "missing");')).toThrow(/not found/);
});

test('dict equality is structural', () => {
  const r = execProgram(`
    let a = dict_set(dict_set(dict_new(), "x", 1), "y", 2);
    let b = dict_set(dict_set(dict_new(), "y", 2), "x", 1);
    let eq = a == b;
  `);
  expect(r.state.frames[0].bindings.eq).toEqual({ tag: 'bool', v: true });
});

// ── snapshot serialization preserves list/dict ───────────────────────────────

test('list/dict survive snapshot JSON roundtrip', async () => {
  const { freshState } = await import('../src/vm.js');
  const state = freshState();
  state.frames[0].bindings.xs = { tag: 'list', items: [{ tag: 'int', v: 1 }, { tag: 'str', v: 'a' }] };
  state.frames[0].bindings.d = { tag: 'dict', entries: { k: { tag: 'bool', v: true } } };
  const json = JSON.stringify(state);
  const back = JSON.parse(json);
  expect(back.frames[0].bindings.xs).toEqual(state.frames[0].bindings.xs);
  expect(back.frames[0].bindings.d).toEqual(state.frames[0].bindings.d);
});
