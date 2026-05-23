// Distributed worker — polls a coordinator for jobs, runs them on the VM,
// heartbeats while working, and reports completion/failure back.
//
// Design notes:
//   * Workers are stateless apart from the workerId. Killing one mid-job is
//     fine — the coordinator's lease will expire and another worker will pick
//     it up. The VM is deterministic on replay (effect log), so re-execution
//     produces the same outcome.
//   * Heartbeats fire on a regular timer while the worker has the process alive.
//     They serve two purposes: (a) liveness signal to the coordinator;
//     (b) per-job lease renewal (the coordinator considers a worker alive iff
//     it heartbeat recently).
//   * The poll loop is just a sleep+fetch loop — no long-polling. Cheap.

import { run } from './../vm.js';
import type { VMState } from './../snapshot.js';
import type { Program } from './../bytecode.js';

export type WorkerOptions = {
  workerId: string;
  coordUrl: string;     // e.g. "http://localhost:7077"
  heartbeatMs?: number;
  pollMs?: number;
  /** If set, exit the worker loop after handling this many jobs. (Tests.) */
  maxJobs?: number;
  /** Optional hook called before each job — tests use it to crash mid-flight. */
  onBeforeRun?: (jobId: string) => void | Promise<void>;
};

export class Worker {
  private running = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private jobsHandled = 0;
  readonly heartbeatMs: number;
  readonly pollMs: number;

  constructor(private opts: WorkerOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? 1000;
    this.pollMs = opts.pollMs ?? 200;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.post('/workers/register', { workerId: this.opts.workerId });
    this.heartbeatTimer = setInterval(() => {
      this.post('/workers/heartbeat', { workerId: this.opts.workerId }).catch(() => {/* ignore */});
    }, this.heartbeatMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    this.loop().catch(err => process.stderr.write(`worker loop error: ${(err as Error).message}\n`));
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  // Main poll-and-run loop. Runs until stop() is called or maxJobs is reached.
  private async loop(): Promise<void> {
    while (this.running) {
      let job: { jobId: string; program: Program; state: VMState } | null = null;
      try {
        const resp = await this.post('/jobs/next', { workerId: this.opts.workerId });
        if (resp.empty) {
          await sleep(this.pollMs);
          continue;
        }
        job = resp as { jobId: string; program: Program; state: VMState };
      } catch (e) {
        // Network error talking to coordinator — back off and retry.
        await sleep(this.pollMs * 5);
        continue;
      }
      try {
        if (this.opts.onBeforeRun) await this.opts.onBeforeRun(job.jobId);
        const result = run(job.program, job.state);
        // Status may be 'completed' or 'paused' — both are valid run outcomes.
        // For now, we report either as 'complete' and return the final VMState.
        await this.post(`/jobs/${job.jobId}/complete`, {
          workerId: this.opts.workerId,
          result: result.state,
        });
      } catch (e) {
        await this.post(`/jobs/${job.jobId}/fail`, {
          workerId: this.opts.workerId,
          error: (e as Error).message,
        }).catch(() => {});
      }
      this.jobsHandled++;
      if (this.opts.maxJobs && this.jobsHandled >= this.opts.maxJobs) {
        await this.stop();
        return;
      }
    }
  }

  private async post(path: string, body: unknown): Promise<any> {
    const resp = await fetch(this.opts.coordUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`${path}: ${resp.status} ${resp.statusText}`);
    return await resp.json();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Convenience: submit a job to a coordinator from a client process. */
export async function submitJob(coordUrl: string, program: Program, state: VMState): Promise<string> {
  const resp = await fetch(coordUrl + '/jobs/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ program, state }),
  });
  if (!resp.ok) throw new Error(`submit: ${resp.status}`);
  const { jobId } = await resp.json() as { jobId: string };
  return jobId;
}

/** Convenience: poll a job until it reaches a terminal status (or timeout). */
export async function awaitJob(coordUrl: string, jobId: string, timeoutMs: number = 30000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(coordUrl + `/jobs/${jobId}`);
    if (resp.ok) {
      const job = await resp.json() as { status: string };
      if (job.status === 'completed' || job.status === 'failed') return job;
    }
    await sleep(50);
  }
  throw new Error(`job ${jobId} did not reach terminal status within ${timeoutMs}ms`);
}
