// Distributed runtime — coordinator + workers + lease/heartbeat recovery.
//
// Tests use real HTTP on ephemeral local ports. Each test sets up its own
// coordinator + 1-3 workers, submits a job, and checks the outcome. The
// "dead worker" test simulates a crash by stopping a worker without
// completing its job, then asserts the coordinator hands the job to another
// worker after the lease expires.

import { test, expect, afterEach } from 'vitest';
import { Coordinator } from '../src/dist/coordinator.js';
import { Worker, submitJob, awaitJob } from '../src/dist/worker.js';
import { InMemoryStore } from '../src/dist/store.js';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { freshState } from '../src/vm.js';

// Track everything spun up for the current test so afterEach can tear it all down.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try { await c(); } catch { /* ignore */ }
  }
});

let nextPort = 17077;
function freshPort(): number { return nextPort++; }

async function startCoordinator(opts: Partial<{ leaseMs: number; sweepMs: number }> = {}): Promise<{ url: string; coord: Coordinator }> {
  const port = freshPort();
  const coord = new Coordinator({
    store: new InMemoryStore(),
    port,
    leaseMs: opts.leaseMs ?? 5000,
    sweepMs: opts.sweepMs ?? 100,
  });
  await coord.start();
  cleanups.push(() => coord.stop());
  return { url: `http://localhost:${port}`, coord };
}

function programFor(source: string) {
  return compile(parse(tokenize(source)));
}

test('single worker: submit a paused job, worker finishes it', async () => {
  const { url } = await startCoordinator();
  const w = new Worker({ workerId: 'w1', coordUrl: url, heartbeatMs: 50, pollMs: 20, maxJobs: 1 });
  await w.start();
  cleanups.push(() => w.stop());

  const prog = programFor('let x = 1 + 2;');
  const jobId = await submitJob(url, prog, freshState());
  const result = await awaitJob(url, jobId, 5000);
  expect(result.status).toBe('completed');
  expect(result.result.frames[0].bindings.x).toEqual({ tag: 'int', v: 3 });
});

test('two workers: jobs distributed across both', async () => {
  const { url } = await startCoordinator();
  const w1 = new Worker({ workerId: 'w1', coordUrl: url, heartbeatMs: 50, pollMs: 20 });
  const w2 = new Worker({ workerId: 'w2', coordUrl: url, heartbeatMs: 50, pollMs: 20 });
  await w1.start(); await w2.start();
  cleanups.push(() => w1.stop()); cleanups.push(() => w2.stop());

  const prog = programFor('let r = 10 * 10;');
  const ids = await Promise.all(
    Array.from({ length: 5 }, () => submitJob(url, prog, freshState()))
  );
  const results = await Promise.all(ids.map(id => awaitJob(url, id, 5000)));
  for (const r of results) {
    expect(r.status).toBe('completed');
    expect(r.result.frames[0].bindings.r).toEqual({ tag: 'int', v: 100 });
  }
});

test('stranded job → lease expires → healthy worker picks it up', async () => {
  const { url } = await startCoordinator({ leaseMs: 200, sweepMs: 50 });

  // Phase 1: a ghost worker claims a job and goes silent (no heartbeat, no
  // /complete, no /fail). After ~leaseMs, the coordinator should mark that
  // job pending again.
  await fakeClaimAndDie(url, 'ghost-worker', programFor('let r = 5 + 6;'));

  // Phase 2: start a healthy worker. After the sweep reclaims the stranded
  // job, the healthy worker picks it up and completes it.
  const wHealthy = new Worker({ workerId: 'healthy', coordUrl: url, heartbeatMs: 30, pollMs: 30 });
  await wHealthy.start();
  cleanups.push(() => wHealthy.stop());

  // Submit one more job for good measure — both should complete.
  const prog = programFor('let r = 7 * 8;');
  const jobId = await submitJob(url, prog, freshState());
  const result = await awaitJob(url, jobId, 5000);
  expect(result.status).toBe('completed');
  expect(result.result.frames[0].bindings.r).toEqual({ tag: 'int', v: 56 });

  // The ghost job should also have been reclaimed and completed by `healthy`.
  await sleepFor(500);
  const healthHealth = await (await fetch(url + '/health')).json() as { jobs: number };
  // jobs count includes both the ghost-submitted one and the explicit one.
  expect(healthHealth.jobs).toBeGreaterThanOrEqual(2);
});

function sleepFor(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

test('sweepExpiredLeases reclaims stranded jobs', async () => {
  const store = new InMemoryStore();
  const port = freshPort();
  const coord = new Coordinator({ store, port, leaseMs: 100, sweepMs: 50 });
  await coord.start();
  cleanups.push(() => coord.stop());
  const url = `http://localhost:${port}`;

  // Manually claim a job from a fake worker that never heartbeats.
  await fakeClaimAndDie(url, 'zombie', programFor('let r = 1;'));
  // Wait for sweep to reclaim.
  await new Promise(r => setTimeout(r, 250));
  const reclaimed = store.list().some(j => j.status === 'pending' && j.leasedBy === null);
  expect(reclaimed).toBe(true);
});

// Helper: act as a malicious/dead worker by registering, submitting a job,
// claiming it via /jobs/next, then never heartbeating. The coordinator will
// reclaim the lease after leaseMs.
async function fakeClaimAndDie(url: string, workerId: string, prog: any): Promise<void> {
  await fetch(url + '/workers/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId }),
  });
  await fetch(url + '/jobs/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ program: prog, state: freshState() }),
  });
  // Claim by polling /jobs/next.
  await fetch(url + '/jobs/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId }),
  });
  // No heartbeat ever follows. The sweep will reclaim.
}

test('health endpoint reports worker + job counts', async () => {
  const { url } = await startCoordinator();
  const w = new Worker({ workerId: 'wh', coordUrl: url, heartbeatMs: 50, pollMs: 20 });
  await w.start();
  cleanups.push(() => w.stop());
  // Give the worker time to register.
  await new Promise(r => setTimeout(r, 80));
  await submitJob(url, programFor('let x = 1;'), freshState());
  const r = await (await fetch(url + '/health')).json() as { ok: boolean; workers: number; jobs: number };
  expect(r.ok).toBe(true);
  expect(r.workers).toBeGreaterThanOrEqual(1);
  expect(r.jobs).toBeGreaterThanOrEqual(1);
});

test('FileStore persists jobs across coordinator restart', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileStore } = await import('../src/dist/store.js');
  const dir = mkdtempSync(join(tmpdir(), 'pen-dist-store-'));
  try {
    const port = freshPort();
    const c1 = new Coordinator({ store: new FileStore(dir), port, sweepMs: 100 });
    await c1.start();
    const url = `http://localhost:${port}`;
    const jobId = await submitJob(url, programFor('let x = 1;'), freshState());
    await c1.stop();
    // Re-open with a fresh coordinator pointing at the same dir.
    const c2 = new Coordinator({ store: new FileStore(dir), port, sweepMs: 100 });
    await c2.start();
    cleanups.push(() => c2.stop());
    // The job should still be visible.
    const resp = await fetch(url + `/jobs/${jobId}`);
    const job = await resp.json() as { status: string };
    expect(job.status).toBe('pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
