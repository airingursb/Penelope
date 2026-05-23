import { test, expect } from 'vitest';
import { sha256, serialize, deserialize } from '../src/snapshot.js';
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

const goodSource = 'let x = 1;';
const goodSnap = {
  version: 1 as const,
  programPath: 'x.pen',
  programHash: 'sha256:' + sha256(goodSource),
  pausedAt: 'n5',
  pausedAtMs: 0,
  state: {
    control: [],
    valueStack: [],
    scopes: { s0: { parentId: null, bindings: {} } },
    currentScopeId: 's0',
    nextScopeIdCounter: 1,
  },
};

test('deserialize accepts a matching source', () => {
  const r = deserialize(serialize(goodSnap), () => goodSource);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap.pausedAt).toBe('n5');
  expect(r.source).toBe(goodSource);
});

test('deserialize rejects on hash mismatch', () => {
  const r = deserialize(serialize(goodSnap), () => 'let x = 2;');
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/source has changed/);
});

test('deserialize bypasses hash check with --force', () => {
  const r = deserialize(serialize(goodSnap), () => 'let x = 2;', { force: true });
  expect('snap' in r).toBe(true);
});

test('deserialize reports corrupt JSON', () => {
  const r = deserialize('{not json', () => goodSource);
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/corrupted/);
});

test('deserialize rejects unknown version', () => {
  const bad = { ...goodSnap, version: 999 };
  const r = deserialize(JSON.stringify(bad), () => goodSource);
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/unknown snapshot version/);
});

test('deserialize reports missing source file', () => {
  const r = deserialize(serialize(goodSnap), () => { throw new Error('ENOENT'); });
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/cannot find source file/);
});
