// Tracer hook: optional VM observability that surfaces fn calls, effects,
// pauses, and errors as structured events. Tests verify the event stream
// matches the expected execution shape.

import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run, freshState } from '../src/vm.js';
import { MemoryTracer, JsonLinesTracer, CompositeTracer, spanNameFor } from '../src/tracer.js';

function progFor(source: string) { return compile(parse(tokenize(source))); }

test('MemoryTracer captures fn_call + fn_return for a simple call', () => {
  const tr = new MemoryTracer();
  run(progFor('let f = fn(n) { n + 1 }; let r = f(7);'), freshState(), undefined, tr);
  const kinds = tr.events.map(e => e.kind);
  expect(kinds).toContain('fn_call');
  expect(kinds).toContain('fn_return');
  // One call → one return.
  expect(kinds.filter(k => k === 'fn_call').length).toBe(1);
  expect(kinds.filter(k => k === 'fn_return').length).toBe(1);
});

test('tracer captures effect events with name and replayed=false on first run', () => {
  const tr = new MemoryTracer();
  run(progFor('print("hello"); print(to_str(42));'), freshState(), undefined, tr);
  const effects = tr.events.filter(e => e.kind === 'effect');
  expect(effects.length).toBe(2);
  for (const e of effects) {
    if (e.kind !== 'effect') throw new Error();
    expect(e.name).toBe('print');
    expect(e.replayed).toBe(false);
  }
});

test('tracer captures pause event when program pauses', () => {
  const tr = new MemoryTracer();
  const r = run(progFor('let x = 1; pause; let y = 2;'), freshState(), undefined, tr);
  expect(r.status).toBe('paused');
  expect(tr.events.some(e => e.kind === 'pause')).toBe(true);
});

test('tracer captures resume event when resuming from snapshot', () => {
  const tr1 = new MemoryTracer();
  const r1 = run(progFor('let x = 1; pause; print("after");'), freshState(), undefined, tr1);
  expect(r1.status).toBe('paused');
  // Now resume with the paused state — the tracer should record a 'resume' event.
  const tr2 = new MemoryTracer();
  run(progFor('let x = 1; pause; print("after");'), r1.state, undefined, tr2);
  expect(tr2.events.some(e => e.kind === 'resume')).toBe(true);
});

test('tracer captures error events when an exception fires', () => {
  const tr = new MemoryTracer();
  expect(() => run(progFor('let r = list_get(list_new(), 5);'), freshState(), undefined, tr))
    .toThrow();
  expect(tr.events.some(e => e.kind === 'error')).toBe(true);
});

test('JsonLinesTracer writes one JSON object per line', () => {
  const lines: string[] = [];
  const stream = { write: (s: string) => { lines.push(s); return true; } };
  const tr = new JsonLinesTracer(stream as any);
  run(progFor('let f = fn() { 1 }; f();'), freshState(), undefined, tr);
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) {
    const parsed = JSON.parse(l.replace(/\n$/, ''));
    expect(parsed.kind).toBeTruthy();
    expect(typeof parsed.t).toBe('number');
  }
});

test('CompositeTracer fans out to multiple sinks', () => {
  const m1 = new MemoryTracer();
  const m2 = new MemoryTracer();
  const tr = new CompositeTracer([m1, m2]);
  run(progFor('print("x");'), freshState(), undefined, tr);
  expect(m1.events.length).toBe(m2.events.length);
  expect(m1.events.length).toBeGreaterThan(0);
});

test('spanNameFor produces useful labels', () => {
  expect(spanNameFor({ kind: 'effect', ip: 0, name: 'print', t: 0, replayed: false })).toBe('effect:print');
  expect(spanNameFor({ kind: 'pause', ip: 5, t: 0, reason: 'pause-op' })).toBe('pause(pause-op)');
  expect(spanNameFor({ kind: 'fn_call', ip: 1, bodyIp: 10, argc: 2, t: 0 })).toBe('fn@ip10');
});
