import { test, expect } from 'vitest';
import { runOptimizer, type OLevel } from '../src/optimizer.js';
import type { Program } from '../src/bytecode.js';

test('-O0 returns program unchanged', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  const out = runOptimizer(prog, 0 as OLevel);
  expect(out).toEqual(prog);
});

test('-O level signature accepts 0/1/2', () => {
  const prog: Program = { version: 1, constants: [], code: [['HALT']] };
  expect(runOptimizer(prog, 0).code).toEqual([['HALT']]);
  expect(runOptimizer(prog, 1).code).toEqual([['HALT']]);
  expect(runOptimizer(prog, 2).code).toEqual([['HALT']]);
});
