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

test('BIN_OP + ints', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 2 }, { tag: 'int', v: 3 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 5 }]);
});

test('BIN_OP < returns bool', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '<'], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'bool', v: true }]);
});

test('BIN_OP + strings concatenates', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'a' }, { tag: 'str', v: 'b' }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'str', v: 'ab' }]);
});

test('BIN_OP / by 0 throws', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 5 }, { tag: 'int', v: 0 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '/'], ['HALT']],
  };
  expect(() => run(prog)).toThrow(/divide by zero/);
});

test('JUMP advances IP unconditionally', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [
      ['LOAD_CONST', 0],
      ['JUMP', 3],
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 1 }]);
});

test('JUMP_IF_FALSE pops and jumps when false', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'bool', v: false }, { tag: 'int', v: 99 }],
    code: [
      ['LOAD_CONST', 0],
      ['JUMP_IF_FALSE', 3],
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([]);
});

test('JUMP_IF_FALSE falls through when true', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'bool', v: true }, { tag: 'int', v: 99 }],
    code: [
      ['LOAD_CONST', 0],
      ['JUMP_IF_FALSE', 4],
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 99 }]);
});

test('JUMP_IF_FALSE on non-bool throws', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['LOAD_CONST', 0], ['JUMP_IF_FALSE', 3], ['HALT']],
  };
  expect(() => run(prog)).toThrow(/expected bool/);
});

test('MAKE_CLOSURE captures top frame index', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['MAKE_CLOSURE', ['x'], 10, 5], ['HALT']],
  };
  const r = run(prog);
  expect(r.state.valueStack[0]).toEqual({
    tag: 'closure', params: ['x'], bodyIp: 10, bodyLen: 5, capturedFrameIdx: 0,
  });
});

test('CALL + RETURN: identity fn', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 7 }],
    code: [
      ['MAKE_CLOSURE', ['x'], 2, 4],
      ['JUMP', 6],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', null],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['STORE_VAR', 'id'],
      ['LOAD_VAR', 'id', null],
      ['LOAD_CONST', 0],
      ['CALL', 1],
      ['HALT'],
    ],
  };
  const r = run(prog);
  expect(r.state.valueStack).toEqual([{ tag: 'int', v: 7 }]);
});

test('closure captures outer binding via parentIdx', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 10 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'y'],
      ['MAKE_CLOSURE', [], 4, 4],
      ['JUMP', 8],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'y', null],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['STORE_VAR', 'f'],
      ['LOAD_VAR', 'f', null],
      ['CALL', 0],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 10 }]);
});
