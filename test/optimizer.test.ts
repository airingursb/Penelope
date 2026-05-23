import { test, expect } from 'vitest';
import { runOptimizer, type OLevel } from '../src/optimizer.js';
import type { Program } from '../src/bytecode.js';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run, freshState } from '../src/vm.js';

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

test('-O1 folds constants', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  const out = runOptimizer(prog, 1);
  expect(out.code.length).toBe(2);
});

test('-O1 applies peephole (eliminates PUSH_UNIT+POP)', () => {
  const prog: Program = { version: 1, constants: [], code: [['PUSH_UNIT'], ['POP'], ['HALT']] };
  expect(runOptimizer(prog, 1).code).toEqual([['HALT']]);
});

test('-O1 applies DCE (eliminates dead code after HALT)', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['HALT'], ['HALT'], ['HALT']],
  };
  expect(runOptimizer(prog, 1).code).toEqual([['HALT']]);
});

test('-O2 annotates LOAD_VAR with IC; -O1 does not', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['LOAD_CONST', 0], ['STORE_VAR', 'x'], ['LOAD_VAR', 'x', null], ['HALT']],
  };
  const o1 = runOptimizer(prog, 1);
  expect((o1.code[2] as ['LOAD_VAR', string, unknown])[2]).toBeNull();
  const o2 = runOptimizer(prog, 2);
  expect((o2.code[2] as ['LOAD_VAR', string, { framesUp: number }])[2]).toEqual({ framesUp: 0 });
});

test('-O2 inlines pure single-use fn; -O1 does not', () => {
  const ast = parse(tokenize('let f = fn(x) { x + 1 }; f(10);'));
  const prog = compile(ast);
  const o1 = runOptimizer(prog, 1);
  expect(o1.code.find(op => op[0] === 'CALL')).toBeDefined();
  const o2 = runOptimizer(prog, 2);
  expect(o2.code.find(op => op[0] === 'CALL')).toBeUndefined();
});

test('full -O2 pipeline: complex program produces same effect log as -O0', () => {
  const source = `
    let add = fn(a, b) { a + b };
    let x = add(1, 2);
    print(to_str(x));
  `;
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  const r0 = run(runOptimizer(prog, 0));
  const r2 = run(runOptimizer(prog, 2));
  expect(r0.status).toBe('halted');
  expect(r2.status).toBe('halted');
  expect(r2.state.effects.map(e => e.recordedValue))
    .toEqual(r0.state.effects.map(e => e.recordedValue));
});
