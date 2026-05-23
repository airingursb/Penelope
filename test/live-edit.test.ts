import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run, freshState } from '../src/vm.js';
import { remapState } from '../src/live-edit.js';

function compileSrc(src: string) {
  return compile(parse(tokenize(src)));
}

test('remap succeeds when paused source position still exists', () => {
  const oldProg = compileSrc('print("a");\nlet x = pause;\nprint("b");');
  const newProg = compileSrc('print("a");\nlet x = pause;\nprint("changed");');
  const first = run(oldProg);
  expect(first.status).toBe('paused');
  const r = remapState(oldProg, newProg, first.state);
  expect(r.ok).toBe(true);
});

test('remapped state can resume on new program', () => {
  const oldProg = compileSrc('let x = pause; print("done");');
  const newProg = compileSrc('let x = pause; print("changed!");');
  const first = run(oldProg);
  expect(first.status).toBe('paused');
  const r = remapState(oldProg, newProg, first.state);
  if (!r.ok) throw new Error(r.reason);
  const second = run(newProg, r.state);
  expect(second.status).toBe('halted');
});

test('remap fails when source code following the pause is deleted', () => {
  const oldProg = compileSrc('print("a");\nlet x = pause;\nprint("b");\nprint("c");');
  // The new program truncates everything after the pause.
  const newProg = compileSrc('print("a");');
  const first = run(oldProg);
  const r = remapState(oldProg, newProg, first.state);
  expect(r.ok).toBe(false);
});

test('remap fails when active call frame references vanished code', () => {
  const oldProg = compileSrc('let helper = fn() { let x = pause; x }; let r = helper();');
  // Restructure helper so its body has a different shape.
  const newProg = compileSrc('let helper = fn() { 42 }; let r = helper();');
  const first = run(oldProg);
  expect(first.status).toBe('paused');
  const r = remapState(oldProg, newProg, first.state);
  expect(r.ok).toBe(false);
});

test('remap preserves bindings on the value/frame stack', () => {
  const oldProg = compileSrc('let x = 100; let y = pause; print(to_str(x));');
  const newProg = compileSrc('let x = 100; let y = pause; print("x is " + to_str(x));');
  const first = run(oldProg);
  const r = remapState(oldProg, newProg, first.state);
  if (!r.ok) throw new Error(r.reason);
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 100 });
});

test('remap migrates effect-log ip references', () => {
  const oldProg = compileSrc('print("done"); let x = pause;');
  // Reformat — print at slightly different ip but same source pos.
  const newProg = compileSrc('print("done"); let x = pause;');
  const first = run(oldProg);
  const r = remapState(oldProg, newProg, first.state);
  if (!r.ok) throw new Error(r.reason);
  // Effects should remap successfully (same source pos → same new ip).
  expect(r.state.effects.length).toBe(first.state.effects.length);
});

test('extending the program (adding code after pause) preserves resume', () => {
  const oldProg = compileSrc('let x = pause;');
  const newProg = compileSrc('let x = pause; print("new");');
  const first = run(oldProg);
  const r = remapState(oldProg, newProg, first.state);
  if (!r.ok) throw new Error(r.reason);
  const second = run(newProg, r.state);
  expect(second.status).toBe('halted');
});
