import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';

test('empty source produces a single EOF token', () => {
  const tokens = tokenize('');
  expect(tokens).toEqual([
    { kind: 'EOF', line: 1, col: 1 },
  ]);
});
