// Penelope snapshot format: JSON.
// Self-contained except for the source file, which is referenced by path+hash.

import { createHash } from 'node:crypto';
import type { NodeId } from './ast.js';
import type { State } from './interpreter.js';

export type Snapshot = {
  version: 2;
  programPath: string;
  programHash: string;        // "sha256:<hex>"
  pausedAt: NodeId;
  pausedAtMs: number;
  state: State;
};

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function serialize(snap: Snapshot): string {
  return JSON.stringify(snap, null, 2);
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

  if ((snap.version as number) !== 2) {
    return { error: `unknown snapshot version: ${snap.version}. Phase 2 uses version 2 (Phase 1 snapshots are not migratable; re-run from source).` };
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
