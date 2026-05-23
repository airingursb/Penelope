import { test, expect } from 'vitest';
import type { Opcode, ConstantPoolEntry, Program } from '../src/bytecode.js';
import { internConstant, makeProgram, OPCODE_NAMES } from '../src/bytecode.js';

test('makeProgram returns empty program with version 1', () => {
  const p = makeProgram();
  expect(p.version).toBe(1);
  expect(p.constants).toEqual([]);
  expect(p.code).toEqual([]);
});

test('internConstant deduplicates equal int entries', () => {
  const pool: ConstantPoolEntry[] = [];
  const i1 = internConstant(pool, { tag: 'int', v: 10 });
  const i2 = internConstant(pool, { tag: 'int', v: 10 });
  const i3 = internConstant(pool, { tag: 'int', v: 20 });
  expect(i1).toBe(0);
  expect(i2).toBe(0);
  expect(i3).toBe(1);
  expect(pool).toEqual([{ tag: 'int', v: 10 }, { tag: 'int', v: 20 }]);
});

test('internConstant deduplicates strings, bools, units separately', () => {
  const pool: ConstantPoolEntry[] = [];
  internConstant(pool, { tag: 'str', v: 'hello' });
  internConstant(pool, { tag: 'str', v: 'hello' });
  internConstant(pool, { tag: 'bool', v: true });
  internConstant(pool, { tag: 'bool', v: true });
  internConstant(pool, { tag: 'unit' });
  internConstant(pool, { tag: 'unit' });
  expect(pool.length).toBe(3);
});

test('Opcode is a tuple — first element is the op name', () => {
  const op: Opcode = ['LOAD_CONST', 0];
  expect(op[0]).toBe('LOAD_CONST');
});

test('all 18 opcode names are exported as a set', () => {
  const expected = [
    'LOAD_CONST', 'LOAD_VAR', 'STORE_VAR', 'BIN_OP',
    'JUMP', 'JUMP_IF_FALSE',
    'MAKE_CLOSURE', 'CALL', 'TAILCALL', 'CALL_BUILTIN', 'RETURN',
    'EFFECT', 'PAUSE',
    'POP', 'PUSH_UNIT',
    'ENTER_BLOCK', 'EXIT_BLOCK',
    'HALT',
  ];
  expect(OPCODE_NAMES.size).toBe(18);
  for (const name of expected) expect(OPCODE_NAMES.has(name)).toBe(true);
});
