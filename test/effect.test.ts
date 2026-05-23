import { test, expect } from 'vitest';
import { EFFECT_NAMES, categoryOf } from '../src/effects.js';

test('EFFECT_NAMES contains all 8 effects', () => {
  expect(EFFECT_NAMES.size).toBe(8);
  for (const name of ['print', 'net_fetch', 'now', 'random_int', 'read_file', 'write_file', 'wait_until', 'wait_for']) {
    expect(EFFECT_NAMES.has(name as any)).toBe(true);
  }
});

test('categoryOf classifies effects correctly', () => {
  expect(categoryOf('print')).toBe('write');
  expect(categoryOf('write_file')).toBe('write');
  expect(categoryOf('net_fetch')).toBe('read');
  expect(categoryOf('now')).toBe('read');
  expect(categoryOf('random_int')).toBe('read');
  expect(categoryOf('read_file')).toBe('read');
  expect(categoryOf('wait_until')).toBe('wait');
  expect(categoryOf('wait_for')).toBe('wait');
});
