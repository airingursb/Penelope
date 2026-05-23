// Penelope snapshot format: JSON.
// Self-contained except for the source file, which is referenced by path+hash.

import { createHash } from 'node:crypto';
import type { NodeId } from './ast.js';
import type { State } from './interpreter.js';

export type Snapshot = {
  version: 1;
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
