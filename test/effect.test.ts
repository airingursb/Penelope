import { test, expect } from 'vitest';
import { EFFECT_NAMES, categoryOf } from '../src/effects.js';
import { serialize, deserialize, sha256 } from '../src/snapshot.js';
import type { Snapshot } from '../src/snapshot.js';

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

test('B4: snapshot with effects[] survives serialize/deserialize roundtrip', () => {
  const source = 'let x = 1;';
  const snap: Snapshot = {
    version: 2,
    programPath: 'x.pen',
    programHash: 'sha256:' + sha256(source),
    pausedAt: 'n5',
    pausedAtMs: 12345,
    state: {
      control: [],
      valueStack: [],
      scopes: { s0: { parentId: null, bindings: {} } },
      currentScopeId: 's0',
      nextScopeIdCounter: 1,
      effects: [
        { nodeId: 'n2', invocationCount: 0, effect: 'print', recordedValue: null, status: 'committed' },
        { nodeId: 'n4', invocationCount: 0, effect: 'net_fetch', recordedValue: { tag: 'str', v: 'response body' }, status: 'committed' },
        { nodeId: 'n6', invocationCount: 0, effect: 'wait_for', recordedValue: { tag: 'str', v: 'approval' }, status: 'pending' },
      ],
    },
  };
  const r = deserialize(serialize(snap), () => source);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap).toEqual(snap);
});

test('H5: hash mismatch with --force preserves effects log on deserialize', () => {
  const source = 'let x = 1;';
  const snap: Snapshot = {
    version: 2,
    programPath: 'x.pen',
    programHash: 'sha256:' + sha256(source),
    pausedAt: 'n5',
    pausedAtMs: 0,
    state: {
      control: [], valueStack: [],
      scopes: { s0: { parentId: null, bindings: {} } },
      currentScopeId: 's0', nextScopeIdCounter: 1,
      effects: [
        { nodeId: 'n1', invocationCount: 0, effect: 'print', recordedValue: null, status: 'committed' },
      ],
    },
  };
  const r = deserialize(serialize(snap), () => 'let x = 2;', { force: true });
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap.state.effects).toHaveLength(1);
  expect(r.snap.state.effects[0].effect).toBe('print');
});
