// Distributed coordinator — a tiny HTTP server that hands out jobs to workers,
// tracks leases + heartbeats, and reclaims jobs from dead workers.
//
// Protocol (HTTP/JSON, all POST except where noted):
//
//   POST /workers/register     {workerId}                              → {ok}
//   POST /workers/heartbeat    {workerId}                              → {ok}
//   POST /jobs/submit          {program, state}                        → {jobId}
//   POST /jobs/next            {workerId}                              → {jobId, program, state} | {empty: true}
//   POST /jobs/:jobId/complete {workerId, result}                      → {ok}
//   POST /jobs/:jobId/fail     {workerId, error}                       → {ok}
//   GET  /jobs/:jobId                                                  → JobRecord
//
// Single-coordinator model: no consensus, no replication. The lease mechanism
// is what gives us safety against dead workers: a job claimed by worker W can
// be reclaimed after `leaseMs` milliseconds without a heartbeat from W.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { JobStore, JobRecord } from './store.js';

export type CoordinatorOptions = {
  store: JobStore;
  port: number;
  /** A job lease expires after this many milliseconds without a heartbeat. */
  leaseMs?: number;
  /** Sweep interval for reclaiming expired leases. */
  sweepMs?: number;
};

export class Coordinator {
  private server: Server | null = null;
  private workers = new Map<string, { lastHeartbeat: number }>();
  private sweepTimer: NodeJS.Timeout | null = null;
  readonly leaseMs: number;
  readonly sweepMs: number;

  constructor(private opts: CoordinatorOptions) {
    this.leaseMs = opts.leaseMs ?? 5000;
    this.sweepMs = opts.sweepMs ?? 1000;
  }

  /** Reclaim any expired leases. Called periodically by sweepTimer. */
  sweepExpiredLeases(now: number = Date.now()): number {
    let reclaimed = 0;
    for (const job of this.opts.store.list()) {
      if (job.status !== 'running') continue;
      if (job.leasedBy === null) continue;
      const worker = this.workers.get(job.leasedBy);
      const lastHb = worker?.lastHeartbeat ?? 0;
      // A job is reclaimable if either:
      //   (a) the worker hasn't heartbeat in `leaseMs`, OR
      //   (b) `leaseMs` has elapsed since the job was claimed and the worker is unknown.
      const expired = (now - lastHb > this.leaseMs) && (now - job.leasedAt > this.leaseMs);
      if (expired) {
        job.status = 'pending';
        job.leasedBy = null;
        job.leasedAt = 0;
        this.opts.store.save(job);
        reclaimed++;
      }
    }
    return reclaimed;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(this.opts.port, () => {
        this.sweepTimer = setInterval(() => this.sweepExpiredLeases(), this.sweepMs);
        // Don't keep the event loop alive just because of the sweep timer.
        if (this.sweepTimer.unref) this.sweepTimer.unref();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    if (this.server) {
      await new Promise<void>((res) => this.server!.close(() => res()));
      this.server = null;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      if (method === 'POST' && url === '/workers/register') {
        const { workerId } = body;
        this.workers.set(workerId, { lastHeartbeat: Date.now() });
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'POST' && url === '/workers/heartbeat') {
        const { workerId } = body;
        if (!this.workers.has(workerId)) {
          // Auto-register on heartbeat (worker may have started before us).
          this.workers.set(workerId, { lastHeartbeat: Date.now() });
        } else {
          this.workers.get(workerId)!.lastHeartbeat = Date.now();
        }
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'POST' && url === '/jobs/submit') {
        const { program, state } = body;
        const jobId = randomUUID();
        const rec: JobRecord = {
          jobId, program, state,
          leasedAt: 0, leasedBy: null,
          status: 'pending',
          createdAt: Date.now(),
        };
        this.opts.store.save(rec);
        return sendJson(res, 200, { jobId });
      }
      if (method === 'POST' && url === '/jobs/next') {
        const { workerId } = body;
        // Find the oldest pending job; mark it running and hand out.
        const pending = this.opts.store.list().filter(j => j.status === 'pending');
        if (pending.length === 0) return sendJson(res, 200, { empty: true });
        const job = pending[0];
        job.status = 'running';
        job.leasedAt = Date.now();
        job.leasedBy = workerId;
        this.opts.store.save(job);
        return sendJson(res, 200, { jobId: job.jobId, program: job.program, state: job.state });
      }
      const completeMatch = url.match(/^\/jobs\/([^/]+)\/complete$/);
      if (method === 'POST' && completeMatch) {
        const jobId = completeMatch[1];
        const { workerId, result } = body;
        const job = this.opts.store.load(jobId);
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        if (job.leasedBy !== workerId) {
          // Stale completion (another worker took over the lease) — silently drop.
          return sendJson(res, 200, { ok: false, reason: 'stale-lease' });
        }
        job.status = 'completed';
        job.result = result;
        job.leasedBy = null;
        this.opts.store.save(job);
        return sendJson(res, 200, { ok: true });
      }
      const failMatch = url.match(/^\/jobs\/([^/]+)\/fail$/);
      if (method === 'POST' && failMatch) {
        const jobId = failMatch[1];
        const { workerId, error } = body;
        const job = this.opts.store.load(jobId);
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        if (job.leasedBy !== workerId) {
          return sendJson(res, 200, { ok: false, reason: 'stale-lease' });
        }
        job.status = 'failed';
        job.error = error;
        job.leasedBy = null;
        this.opts.store.save(job);
        return sendJson(res, 200, { ok: true });
      }
      const getMatch = url.match(/^\/jobs\/([^/]+)$/);
      if (method === 'GET' && getMatch) {
        const job = this.opts.store.load(getMatch[1]);
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        return sendJson(res, 200, job);
      }
      if (method === 'GET' && url === '/health') {
        return sendJson(res, 200, { ok: true, workers: this.workers.size, jobs: this.opts.store.list().length });
      }
      return sendJson(res, 404, { error: `unknown route: ${method} ${url}` });
    } catch (e) {
      return sendJson(res, 500, { error: (e as Error).message });
    }
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`bad json: ${(e as Error).message}`)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
