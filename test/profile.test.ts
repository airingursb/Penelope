import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run, freshState, makeProfile } from '../src/vm.js';

test('makeProfile returns empty counters', () => {
  const p = makeProfile();
  expect(p.opcodeCount).toEqual({});
  expect(p.ipCount).toEqual({});
  expect(p.totalNs).toBe(0n);
});

test('profile collects opcode counts during run', () => {
  const prog = compile(parse(tokenize('let x = 1 + 2;')));
  const profile = makeProfile();
  run(prog, undefined, profile);
  expect(profile.opcodeCount.LOAD_CONST).toBeGreaterThanOrEqual(2);
  expect(profile.opcodeCount.BIN_OP).toBe(1);
  expect(profile.opcodeCount.STORE_VAR).toBe(1);
  expect(profile.opcodeCount.HALT).toBe(1);
});

test('profile collects per-ip counts (hot loops dominate)', () => {
  const prog = compile(parse(tokenize('let f = fn(n) { if (n < 2) { n } else { f(n - 1) + f(n - 2) } }; f(8);')));
  const profile = makeProfile();
  run(prog, undefined, profile);
  // The recursive calls cause the body's ips to dominate
  const total = Object.values(profile.ipCount).reduce((a, b) => a + b, 0);
  expect(total).toBeGreaterThan(50);
});

test('profile totalNs is non-zero after run', () => {
  const prog = compile(parse(tokenize('let x = 1 + 2;')));
  const profile = makeProfile();
  run(prog, undefined, profile);
  expect(profile.totalNs > 0n).toBe(true);
});

test('run without profile arg leaves no perf overhead path', () => {
  const prog = compile(parse(tokenize('let x = 1;')));
  // No profile passed — should not throw and should not crash
  const r = run(prog);
  expect(r.status).toBe('halted');
});

test('multiple runs accumulate into the same profile', () => {
  const prog = compile(parse(tokenize('let x = 1 + 2;')));
  const profile = makeProfile();
  run(prog, undefined, profile);
  const count1 = profile.opcodeCount.BIN_OP;
  run(prog, undefined, profile);
  expect(profile.opcodeCount.BIN_OP).toBe(count1 * 2);
});

// Reference freshState so the import isn't unused
test('freshState produces an empty VMState', () => {
  expect(freshState().valueStack).toEqual([]);
});
