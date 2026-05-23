// Penelope snapshot format: JSON, optionally gzipped on disk.
// Self-contained except for the source file, which is referenced by path+hash.

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Value } from './ast.js';

export type Frame = {
  bindings: Record<string, Value>;
  returnIP?: number;
  parentIdx?: number;
};

export type VMState = {
  ip: number;
  valueStack: Value[];
  frames: Frame[];
  effects: EffectEntry[];
  timeOverride?: number | null;
  noReplay?: boolean;
};

export type EffectEntry = {
  ip: number;
  invocationCount: number;
  effect: 'print' | 'net_fetch' | 'now' | 'random_int' | 'read_file' | 'write_file' | 'wait_until' | 'wait_for';
  recordedValue: Value | null;
  status: 'pending' | 'committed';
  eventName?: string;          // For wait_for: the name passed to wait_for("name")
  waitUntilMs?: number;        // For wait_until: the target time (ms epoch)
};

export type Snapshot = {
  version: 3;
  programPath: string;
  programHash: string;        // "sha256:<hex>"
  pausedAtIP: number;
  pausedAtMs: number;
  state: VMState;
};

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function serialize(snap: Snapshot): string {
  return JSON.stringify(snap, null, 2);
}

/**
 * Serialize to a Buffer, optionally gzip-compressed. Compressed output starts
 * with the gzip magic bytes (0x1f 0x8b) so deserializeBytes can auto-detect.
 *
 * For large states (long effect logs, deep value stacks) gzip cuts disk size
 * 5-20×. The CPU cost is negligible compared to the snapshot's evaluation cost.
 */
export function serializeBytes(snap: Snapshot, opts: { compress?: boolean } = { compress: true }): Buffer {
  const json = serialize(snap);
  if (opts.compress === false) return Buffer.from(json, 'utf8');
  return gzipSync(Buffer.from(json, 'utf8'));
}

/** True if the buffer starts with the gzip magic number 1f 8b. */
function isGzip(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Deserialize from raw bytes (auto-detects gzip vs plain JSON). Older
 * uncompressed .penz files continue to work; new files written via
 * serializeBytes default to gzip.
 */
export function deserializeBytes(
  bytes: Buffer,
  resolveSource: (programPath: string) => string,
  options: DeserializeOptions = {},
): DeserializeResult {
  const json = isGzip(bytes) ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  return deserialize(json, resolveSource, options);
}

export type DeserializeResult =
  | { snap: Snapshot; source: string }
  | { error: string };

export type DeserializeOptions = {
  force?: boolean;
};

export function deserialize(
  json: string,
  resolveSource: (programPath: string) => string,
  options: DeserializeOptions = {},
): DeserializeResult {
  let snap: Snapshot;
  try {
    snap = JSON.parse(json);
  } catch {
    return { error: 'snapshot is corrupted (invalid JSON)' };
  }

  if ((snap.version as number) !== 3) {
    return {
      error: `unknown snapshot version: ${snap.version}. Phase 3 uses version 3 (v1/v2 snapshots are not migratable; re-run from source).`,
    };
  }

  let source: string;
  try {
    source = resolveSource(snap.programPath);
  } catch {
    return { error: `cannot find source file: ${snap.programPath}. Use --source to override.` };
  }

  const actualHash = 'sha256:' + sha256(source);
  if (actualHash !== snap.programHash && !options.force) {
    return { error: `source has changed since pause (expected ${snap.programHash}, got ${actualHash}). Use --force to override.` };
  }

  return { snap, source };
}
