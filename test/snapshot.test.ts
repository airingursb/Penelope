import { test, expect } from 'vitest';
import { sha256, serialize, deserialize } from '../src/snapshot.js';
import type { Snapshot } from '../src/snapshot.js';

test('sha256 produces a deterministic hex digest', () => {
  expect(sha256('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('serialize produces valid pretty-printed JSON', () => {
  const snap: Snapshot = {
    version: 3,
    programPath: 'x.pen',
    programHash: 'sha256:deadbeef',
    pausedAtIP: 5,
    pausedAtMs: 1234567890,
    state: {
      ip: 5,
      valueStack: [],
      frames: [{ bindings: {} }],
      effects: [],
    },
  };
  const json = serialize(snap);
  expect(JSON.parse(json)).toEqual(snap);
  expect(json).toContain('\n');
});

const goodSource = 'let x = 1;';
const goodSnap = {
  version: 3 as const,
  programPath: 'x.pen',
  programHash: 'sha256:' + sha256(goodSource),
  pausedAtIP: 5,
  pausedAtMs: 0,
  state: {
    ip: 5,
    valueStack: [],
    frames: [{ bindings: {} }],
    effects: [],
  },
};

test('deserialize accepts a matching source', () => {
  const r = deserialize(serialize(goodSnap), () => goodSource);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap.pausedAtIP).toBe(5);
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

test('deserialize rejects v2 snapshots with helpful message', () => {
  const v2snap = {
    version: 2,
    programPath: 'x.pen',
    programHash: 'sha256:abc',
    pausedAt: 'n5',
    pausedAtMs: 0,
    state: { control: [], valueStack: [], scopes: { s0: { parentId: null, bindings: {} } }, currentScopeId: 's0', nextScopeIdCounter: 1, effects: [] },
  };
  const r = deserialize(JSON.stringify(v2snap), () => 'let x = 1;');
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/version 3/);
});

test('deserialize reports missing source file', () => {
  const r = deserialize(serialize(goodSnap), () => { throw new Error('ENOENT'); });
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/cannot find source file/);
});

test('v3 snapshot with VMState roundtrips', () => {
  const source = 'let x = 1;';
  const snap = {
    version: 3 as const,
    programPath: 'x.penc',
    programHash: 'sha256:' + sha256(source),
    pausedAtIP: 42,
    pausedAtMs: 0,
    state: {
      ip: 42,
      valueStack: [{ tag: 'int' as const, v: 10 }],
      frames: [{ bindings: { x: { tag: 'int' as const, v: 5 } } }],
      effects: [],
    },
  };
  const r = deserialize(JSON.stringify(snap), () => source);
  if ('error' in r) throw new Error(r.error);
  if (r.snap.version !== 3) throw new Error('expected v3');
  expect(r.snap.state.ip).toBe(42);
  expect(r.snap.state.valueStack).toHaveLength(1);
  expect(r.snap.state.frames).toHaveLength(1);
});
