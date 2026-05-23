import { test, expect } from 'vitest';
import { sha256, serialize } from '../src/snapshot.js';
import type { Snapshot } from '../src/snapshot.js';

test('sha256 produces a deterministic hex digest', () => {
  expect(sha256('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('serialize produces valid pretty-printed JSON', () => {
  const snap: Snapshot = {
    version: 1,
    programPath: 'x.pen',
    programHash: 'sha256:deadbeef',
    pausedAt: 'n5',
    pausedAtMs: 1234567890,
    state: {
      control: [{ op: 'pushUnit' }],
      valueStack: [],
      scopes: { s0: { parentId: null, bindings: {} } },
      currentScopeId: 's0',
      nextScopeIdCounter: 1,
    },
  };
  const json = serialize(snap);
  expect(JSON.parse(json)).toEqual(snap);
  expect(json).toContain('\n');
});
