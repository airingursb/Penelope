import { test, expect } from 'vitest';
import { extractExpectations, checkExpectations } from '../src/test-runner.js';

test('extracts EXPECT lines preserving order', () => {
  const src = `
print("a");
// EXPECT: a
print("b");
// EXPECT: b
`;
  const e = extractExpectations(src);
  expect(e).toEqual([
    { kind: 'eq', text: 'a', line: 3 },
    { kind: 'eq', text: 'b', line: 5 },
  ]);
});

test('extracts EXPECTS (prefix) variants', () => {
  const src = `
// EXPECTS: result =
`;
  const e = extractExpectations(src);
  expect(e).toEqual([{ kind: 'prefix', text: 'result =', line: 2 }]);
});

test('passes when stdout matches expectations exactly', () => {
  const e = [
    { kind: 'eq' as const, text: 'a', line: 1 },
    { kind: 'eq' as const, text: 'b', line: 2 },
  ];
  const r = checkExpectations(e, 'a\nb\n');
  expect(r.pass).toBe(true);
});

test('fails when a line mismatches', () => {
  const e = [{ kind: 'eq' as const, text: 'a', line: 1 }];
  const r = checkExpectations(e, 'x\n');
  expect(r.pass).toBe(false);
  expect(r.failed[0].got).toBe('x');
});

test('EXPECTS (prefix) passes on prefix match', () => {
  const e = [{ kind: 'prefix' as const, text: 'res:', line: 1 }];
  const r = checkExpectations(e, 'res: 42\n');
  expect(r.pass).toBe(true);
});

test('fails when stdout has too few lines', () => {
  const e = [
    { kind: 'eq' as const, text: 'a', line: 1 },
    { kind: 'eq' as const, text: 'b', line: 2 },
  ];
  const r = checkExpectations(e, 'a\n');
  expect(r.pass).toBe(false);
  expect(r.failed[0].got).toBeUndefined();
});

test('excess output is reported but not a failure', () => {
  const e = [{ kind: 'eq' as const, text: 'a', line: 1 }];
  const r = checkExpectations(e, 'a\nb\nc\n');
  expect(r.pass).toBe(true);
  expect(r.excessOutput).toEqual(['b', 'c']);
});
