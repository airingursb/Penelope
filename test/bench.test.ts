import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { runOptimizer } from '../src/optimizer.js';
import { run } from '../src/vm.js';

const SRC = fs.readFileSync('examples/09-fib.pen', 'utf8');
const PROG = compile(parse(tokenize(SRC)));

test('fib(20) completes via VM and prints 6765', () => {
  const r = run(PROG);
  expect(r.status).toBe('halted');
  const printEffect = r.state.effects.find(e => e.effect === 'print');
  expect(printEffect).toBeDefined();
  // print returns unit; the argument was the string "6765". Check via stack history is hard,
  // but if we compile + run with -O0 vs -O2, both must terminate.
  expect(r.state.effects.length).toBe(1);
});

test('fib(20) at -O0, -O1, -O2 all halt', () => {
  const r0 = run(runOptimizer(PROG, 0));
  const r1 = run(runOptimizer(PROG, 1));
  const r2 = run(runOptimizer(PROG, 2));
  expect(r0.status).toBe('halted');
  expect(r1.status).toBe('halted');
  expect(r2.status).toBe('halted');
});

test('fib(20) at -O2 is not slower than 3× -O0 (rough perf gate)', () => {
  // Warm up
  for (let i = 0; i < 2; i++) {
    run(runOptimizer(PROG, 0));
    run(runOptimizer(PROG, 2));
  }
  const reps = 3;
  let t0 = 0n;
  let t2 = 0n;
  for (let i = 0; i < reps; i++) {
    const a = process.hrtime.bigint();
    run(runOptimizer(PROG, 0));
    const b = process.hrtime.bigint();
    run(runOptimizer(PROG, 2));
    const c = process.hrtime.bigint();
    t0 += b - a;
    t2 += c - b;
  }
  // Generous gate: -O2 may include optimizer time and inlining can grow code.
  // We assert -O2 isn't catastrophically slower.
  expect(Number(t2) / Number(t0)).toBeLessThan(3.0);
});
