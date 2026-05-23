// Snapshot store abstraction — used by the distributed coordinator to keep
// paused-program state durable. Two implementations:
//
//   FileStore     — JSON files in a directory. Persists across restarts.
//   InMemoryStore — Map<id, snapshot>. For tests.
//
// "Snapshot" here is broader than src/snapshot.ts's VMState-only Snapshot: a
// distributed job needs both the program (bytecode) AND the state to be
// portable to any worker.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Program } from './../bytecode.js';
import type { VMState } from './../snapshot.js';

export type JobRecord = {
  jobId: string;
  program: Program;
  state: VMState;
  /** When this job was claimed (epoch ms) — 0 if unclaimed. */
  leasedAt: number;
  /** Worker that holds the lease, or null if unclaimed. */
  leasedBy: string | null;
  /** Job status. */
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  /** When complete: the final VMState (effect log + any printed output marker). */
  result?: VMState;
  /** When failed: the error message. */
  error?: string;
  /** Monotonic creation time (epoch ms). */
  createdAt: number;
};

export interface JobStore {
  save(rec: JobRecord): void;
  load(jobId: string): JobRecord | null;
  list(): JobRecord[];
  delete(jobId: string): void;
}

/** Filesystem-backed job store. One JSON file per job, named `<jobId>.json`. */
export class FileStore implements JobStore {
  constructor(private dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }
  save(rec: JobRecord): void {
    const tmp = join(this.dir, `.${rec.jobId}.tmp`);
    const final = join(this.dir, `${rec.jobId}.json`);
    writeFileSync(tmp, JSON.stringify(rec));
    // Atomic rename: writers either see the old file or the new one, never partial.
    renameSync(tmp, final);
  }
  load(jobId: string): JobRecord | null {
    const f = join(this.dir, `${jobId}.json`);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8')) as JobRecord;
  }
  list(): JobRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: JobRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as JobRecord);
      } catch { /* skip corrupt entry */ }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
  delete(jobId: string): void {
    const f = join(this.dir, `${jobId}.json`);
    if (existsSync(f)) unlinkSync(f);
  }
}

/** In-memory job store. Loses data on process exit; use only for tests. */
export class InMemoryStore implements JobStore {
  private data = new Map<string, JobRecord>();
  save(rec: JobRecord): void { this.data.set(rec.jobId, structuredClone(rec)); }
  load(jobId: string): JobRecord | null {
    const r = this.data.get(jobId);
    return r ? structuredClone(r) : null;
  }
  list(): JobRecord[] {
    return [...this.data.values()].map(r => structuredClone(r)).sort((a, b) => a.createdAt - b.createdAt);
  }
  delete(jobId: string): void { this.data.delete(jobId); }
}
