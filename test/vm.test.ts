// test/vm.test.ts
import { test, expect } from 'vitest';
import { run, freshState } from '../src/vm.js';
import type { Program } from '../src/bytecode.js';

test('HALT-only program completes with empty stack', () => {
  const prog: Program = { version: 1, constants: [], code: [['HALT']] };
  const result = run(prog);
  expect(result.status).toBe('halted');
  expect(result.state.ip).toBe(0);
  expect(result.state.valueStack).toEqual([]);
  expect(result.state.frames).toHaveLength(1);
});

test('LOAD_CONST pushes constant; POP removes top', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 42 }],
    code: [['LOAD_CONST', 0], ['POP'], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([]);
});

test('LOAD_CONST without POP leaves value on stack', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 7 }],
    code: [['LOAD_CONST', 0], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 7 }]);
});

test('PUSH_UNIT pushes unit', () => {
  const prog: Program = { version: 1, constants: [], code: [['PUSH_UNIT'], ['HALT']] };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'unit' }]);
});

test('STORE_VAR writes to top frame; LOAD_VAR reads it', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 10 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'x'],
      ['LOAD_VAR', 'x', null],
      ['HALT'],
    ],
  };
  const r = run(prog);
  expect(r.state.valueStack).toEqual([{ tag: 'int', v: 10 }]);
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 10 });
});

test('LOAD_VAR walks frame chain (linear)', () => {
  const prog: Program = { version: 1, constants: [], code: [['LOAD_VAR', 'x', null], ['HALT']] };
  const initial = freshState();
  initial.frames[0].bindings.x = { tag: 'int', v: 5 };
  initial.frames.push({ bindings: {} });
  expect(run(prog, initial).state.valueStack).toEqual([{ tag: 'int', v: 5 }]);
});

test('LOAD_VAR undefined throws', () => {
  const prog: Program = { version: 1, constants: [], code: [['LOAD_VAR', 'oops', null], ['HALT']] };
  expect(() => run(prog)).toThrow(/undefined variable 'oops'/);
});
