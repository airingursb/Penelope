// Tracer — observability hook for the VM. Optional; when present, the VM
// emits structured events at function boundaries, effects, pauses, and errors.
// Designed to mirror OpenTelemetry's span shape closely enough that wrapping
// this in an OTel exporter is a few-line adapter.
//
// Why not OpenTelemetry directly? Zero-dep is a Penelope value. OTel pulls in
// ~1MB of transitive deps. A 50-line tracer abstraction with a clean event
// model lets users adapt to OTel, Datadog, Honeycomb, or just stderr JSON.

import type { EffectEntry, VMState } from './snapshot.js';

export type TraceEvent =
  | { kind: 'fn_call';   ip: number; bodyIp: number; argc: number; t: number }
  | { kind: 'fn_return'; ip: number; t: number }
  | { kind: 'effect';    ip: number; name: EffectEntry['effect']; t: number; replayed: boolean }
  | { kind: 'pause';     ip: number; t: number; reason: 'pause-op' | 'wait-effect' }
  | { kind: 'resume';    ip: number; t: number }
  | { kind: 'error';     ip: number; t: number; message: string };

/**
 * A Tracer collects TraceEvents emitted by the VM. The default implementations
 * write to memory or stderr as JSON lines; production code is expected to
 * provide its own adapter (OpenTelemetry exporter, Datadog StatsD, etc.).
 */
export interface Tracer {
  emit(event: TraceEvent): void;
}

/** Buffer-in-memory tracer — useful for tests and short-lived programs. */
export class MemoryTracer implements Tracer {
  readonly events: TraceEvent[] = [];
  emit(event: TraceEvent): void { this.events.push(event); }
}

/** Write each event as a JSON line to stderr (or any WritableStream). */
export class JsonLinesTracer implements Tracer {
  constructor(private stream: { write(s: string): unknown } = process.stderr) {}
  emit(event: TraceEvent): void {
    this.stream.write(JSON.stringify(event) + '\n');
  }
}

/** Fan-out tracer — forward each event to several underlying tracers. */
export class CompositeTracer implements Tracer {
  constructor(private tracers: Tracer[]) {}
  emit(event: TraceEvent): void {
    for (const t of this.tracers) t.emit(event);
  }
}

/** Adapter helper: turn a VMState into a high-level span name for OTel-style tracers. */
export function spanNameFor(event: TraceEvent): string {
  switch (event.kind) {
    case 'fn_call':   return `fn@ip${event.bodyIp}`;
    case 'fn_return': return `return@ip${event.ip}`;
    case 'effect':    return `effect:${event.name}`;
    case 'pause':     return `pause(${event.reason})`;
    case 'resume':    return `resume@ip${event.ip}`;
    case 'error':     return `error@ip${event.ip}`;
  }
}

// Re-exported here so the VM doesn't have to import a 2nd type.
export type { VMState };
