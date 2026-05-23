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
