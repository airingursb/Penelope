// Snapshot gzip compression — new writes default to gzipped output; older
// uncompressed .penz files keep working via auto-detection.

import { test, expect } from 'vitest';
import { serialize, serializeBytes, deserialize, deserializeBytes, type Snapshot } from '../src/snapshot.js';
import { sha256 } from '../src/snapshot.js';
import { freshState } from '../src/vm.js';

function fakeSnapshot(): Snapshot {
  // A modest payload — enough that compression should show a meaningful saving.
  const state = freshState();
  state.frames[0].bindings = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`var_${i}`, { tag: 'int' as const, v: i * 7919 }])
  );
  state.effects = Array.from({ length: 20 }, (_, i) => ({
    ip: i, invocationCount: 1,
    effect: 'print' as const,
    recordedValue: { tag: 'str' as const, v: `recorded message number ${i} with some padding`.repeat(3) },
    status: 'committed' as const,
  }));
  return {
    version: 3,
    programPath: 'demo.penc',
    programHash: 'sha256:' + sha256('let x = 1;'),
    pausedAtIP: 0,
    pausedAtMs: 1000,
    state,
  };
}

test('serializeBytes gzipped output starts with gzip magic bytes', () => {
  const snap = fakeSnapshot();
  const compressed = serializeBytes(snap, { compress: true });
  expect(compressed[0]).toBe(0x1f);
  expect(compressed[1]).toBe(0x8b);
});

test('serializeBytes uncompressed output is just JSON', () => {
  const snap = fakeSnapshot();
  const plain = serializeBytes(snap, { compress: false });
  // First byte of "{" — JSON object opener.
  expect(plain[0]).toBe(0x7b);
});

test('compressed snapshot is significantly smaller than JSON', () => {
  const snap = fakeSnapshot();
  const plain = Buffer.byteLength(serialize(snap));
  const compressed = serializeBytes(snap, { compress: true }).length;
  // For this repetitive payload we expect ≥3× compression. Real-world data
  // varies — the assertion is the lower bound.
  expect(compressed).toBeLessThan(plain / 3);
});

test('deserializeBytes auto-detects gzip', () => {
  const snap = fakeSnapshot();
  const compressed = serializeBytes(snap, { compress: true });
  const result = deserializeBytes(compressed, () => 'let x = 1;');
  expect('snap' in result).toBe(true);
  if ('snap' in result) {
    expect(result.snap.programHash).toBe(snap.programHash);
    expect(result.snap.state.effects.length).toBe(snap.state.effects.length);
  }
});

test('deserializeBytes still reads legacy uncompressed JSON .penz files', () => {
  const snap = fakeSnapshot();
  const json = serialize(snap);
  const bytes = Buffer.from(json, 'utf8');
  const result = deserializeBytes(bytes, () => 'let x = 1;');
  expect('snap' in result).toBe(true);
});

test('round-trip: gzip then deserialize yields identical content', () => {
  const snap = fakeSnapshot();
  const bytes = serializeBytes(snap, { compress: true });
  const result = deserializeBytes(bytes, () => 'let x = 1;');
  if (!('snap' in result)) throw new Error(result.error);
  // Programs/state should match byte-for-byte after re-serialization.
  expect(serialize(result.snap)).toBe(serialize(snap));
});

test('hash-mismatch detection still works on gzipped snapshots', () => {
  const snap = fakeSnapshot();
  const bytes = serializeBytes(snap, { compress: true });
  // Resolve a DIFFERENT source so the hash check fails.
  const result = deserializeBytes(bytes, () => 'let y = 99;');
  expect('error' in result).toBe(true);
});

test('text deserialize still works (back-compat)', () => {
  const snap = fakeSnapshot();
  const json = serialize(snap);
  const r = deserialize(json, () => 'let x = 1;');
  expect('snap' in r).toBe(true);
});
