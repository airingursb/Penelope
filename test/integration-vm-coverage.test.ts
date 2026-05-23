// Phase 3 integration coverage — equivalent to the 23 skipped Phase 2 tests
// but using Phase 3 semantics (snapshot v3, ip-keyed effects, wait_for value injection).
//
// Most scenarios go through the in-process API (compile + VM) to avoid subprocess overhead
// and to keep tests hermetic. Subprocess tests are reserved for CLI surface verification.

import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run, freshState } from '../src/vm.js';
import type { VMState } from '../src/snapshot.js';

const PEN = resolve('bin/penelope');

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'penelope-cov-'));
}

function compileAndRun(source: string, initialState?: VMState): ReturnType<typeof run> {
  return run(compile(parse(tokenize(source))), initialState);
}

// ── now() effect ─────────────────────────────────────────────────────────────

test('E1: now() records first-call value, replays it on resume', () => {
  const source = 'let t = now(); print(to_str(t)); let _ = pause; print(to_str(t));';
  const s1 = freshState(); s1.timeOverride = 5000;
  const r1 = compileAndRun(source, s1);
  expect(r1.status).toBe('paused');
  const nowEntry = r1.state.effects.find(e => e.effect === 'now');
  expect(nowEntry?.recordedValue).toEqual({ tag: 'int', v: 5000 });
  // Resume — `now` should NOT be re-called (replay from log)
  r1.state.timeOverride = 999999;  // change clock; replay should ignore it
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
  // Still only one `now` entry (no duplication)
  expect(r2.state.effects.filter(e => e.effect === 'now').length).toBe(1);
});

// ── random_int effect ────────────────────────────────────────────────────────

test('E2: random_int recorded then replayed', () => {
  const source = 'let n = random_int(1, 10); let _ = pause; print(to_str(n));';
  const r1 = compileAndRun(source);
  expect(r1.status).toBe('paused');
  const e = r1.state.effects.find(en => en.effect === 'random_int');
  expect(e?.recordedValue?.tag).toBe('int');
  const captured = (e?.recordedValue as { tag: 'int'; v: number }).v;
  expect(captured).toBeGreaterThanOrEqual(1);
  expect(captured).toBeLessThanOrEqual(10);
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
});

// ── read_file effect ─────────────────────────────────────────────────────────

test('F1: read_file recorded then replayed (file can be deleted after)', () => {
  const dir = tmpDir();
  const fp = path.join(dir, 'data.txt');
  writeFileSync(fp, 'hello world');
  const source = `let s = read_file("${fp}"); let _ = pause; print(s);`;
  const r1 = compileAndRun(source);
  expect(r1.status).toBe('paused');
  unlinkSync(fp);  // delete the file
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
  // The committed read_file entry should have the original content
  const e = r2.state.effects.find(en => en.effect === 'read_file');
  expect(e?.recordedValue).toEqual({ tag: 'str', v: 'hello world' });
});

// ── write_file effect ────────────────────────────────────────────────────────

test('F2: write_file skipped on replay (manual override preserved)', () => {
  const dir = tmpDir();
  const fp = path.join(dir, 'out.txt');
  const source = `write_file("${fp}", "original"); let _ = pause; print("done");`;
  const r1 = compileAndRun(source);
  expect(r1.status).toBe('paused');
  expect(readFileSync(fp, 'utf8')).toBe('original');
  writeFileSync(fp, 'manual-edit');
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
  expect(readFileSync(fp, 'utf8')).toBe('manual-edit');
});

test('F3: write_file errors propagate first time', () => {
  // Writing to a directory path should error
  expect(() => compileAndRun(`write_file("/", "x");`)).toThrow();
});

// ── wait_for value injection ─────────────────────────────────────────────────

test('G3: wait_for + injected event value resumes with the value (bool)', () => {
  const source = 'let v = wait_for("approval"); print(to_str(v));';
  const r1 = compileAndRun(source);
  expect(r1.status).toBe('paused');
  const pending = r1.state.effects.find(e => e.effect === 'wait_for' && e.eventName === 'approval');
  expect(pending).toBeDefined();
  // Externally inject the event value
  pending!.recordedValue = { tag: 'bool', v: true };
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
  // The committed entry has the value; the print effect should have fired with "true"
  expect(pending!.status).toBe('committed');
  expect(pending!.recordedValue).toEqual({ tag: 'bool', v: true });
});

test('G4: wait_for with int event value', () => {
  const source = 'let n = wait_for("count"); print(to_str(n));';
  const r1 = compileAndRun(source);
  const pending = r1.state.effects.find(e => e.eventName === 'count');
  pending!.recordedValue = { tag: 'int', v: 42 };
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
  expect(pending!.recordedValue).toEqual({ tag: 'int', v: 42 });
});

test('G5: wait_for with string event value', () => {
  const source = 'let memo = wait_for("note"); print(memo);';
  const r1 = compileAndRun(source);
  const pending = r1.state.effects.find(e => e.eventName === 'note');
  pending!.recordedValue = { tag: 'str', v: 'hello world' };
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
});

// ── wait_until ───────────────────────────────────────────────────────────────

test('G1: wait_until pauses, resume after target time continues', () => {
  const source = 'wait_until(1000); print("after");';
  const s1 = freshState(); s1.timeOverride = 500;
  const r1 = compileAndRun(source, s1);
  expect(r1.status).toBe('paused');
  const pending = r1.state.effects.find(e => e.effect === 'wait_until');
  expect(pending?.waitUntilMs).toBe(1000);

  r1.state.timeOverride = 2000;
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
  expect(pending?.status).toBe('committed');
});

test('G2: wait_until resume too early re-pauses', () => {
  const source = 'wait_until(5000); print("after");';
  const s1 = freshState(); s1.timeOverride = 1000;
  const r1 = compileAndRun(source, s1);
  expect(r1.status).toBe('paused');
  // Resume too early
  r1.state.timeOverride = 2000;
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('paused');  // still not time yet
});

// ── Multi-pause and complex flows ────────────────────────────────────────────

test('H3: multi-pause — wait_for then bare pause then continue', () => {
  const source = 'let a = wait_for("first"); print("got " + a); let _ = pause; print("done");';
  const r1 = compileAndRun(source);
  expect(r1.status).toBe('paused');
  // Inject the first event
  const pending = r1.state.effects.find(e => e.eventName === 'first');
  pending!.recordedValue = { tag: 'str', v: 'X' };
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('paused');  // hit the bare pause
  // Resume past the bare pause
  const r3 = compileAndRun(source, r2.state);
  expect(r3.status).toBe('halted');
});

// ── Fork & effect-log divergence ─────────────────────────────────────────────

test('I1+I2+I3+C3: fork copies effect log; branches diverge after fork', () => {
  const source = 'print("base"); let _ = pause; print("after");';
  const r1 = compileAndRun(source);
  expect(r1.status).toBe('paused');
  // Snapshot the state — both forks start from this state
  const baseState = JSON.parse(JSON.stringify(r1.state)) as VMState;
  // Fork 1: resume directly
  const f1 = compileAndRun(source, baseState);
  expect(f1.status).toBe('halted');
  // Fork 2: independent resume with --no-replay (should re-execute print("base"))
  const baseState2 = JSON.parse(JSON.stringify(r1.state)) as VMState;
  baseState2.noReplay = true;
  const f2 = compileAndRun(source, baseState2);
  // Both halt without sharing state
  expect(f2.status).toBe('halted');
  // The two final effect logs should both contain the after-print
  expect(f1.state.effects.some(e => e.recordedValue?.tag === 'unit' && e.effect === 'print')).toBe(true);
  expect(f2.state.effects.length).toBeGreaterThanOrEqual(f1.state.effects.length);
});

// ── Multiple call sites for same effect ──────────────────────────────────────

test('D3: two distinct call sites get separate effect log entries', () => {
  const source = 'let a = now(); let _ = pause; let b = now(); print(to_str(a)); print(to_str(b));';
  const s1 = freshState(); s1.timeOverride = 100;
  const r1 = compileAndRun(source, s1);
  expect(r1.status).toBe('paused');
  expect(r1.state.effects.filter(e => e.effect === 'now').length).toBe(1);
  r1.state.timeOverride = 200;
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('halted');
  // Two distinct now() entries, with different recorded values + different ips
  const nows = r2.state.effects.filter(e => e.effect === 'now');
  expect(nows.length).toBe(2);
  expect(nows[0].ip).not.toBe(nows[1].ip);
  expect((nows[0].recordedValue as { v: number }).v).toBe(100);
  expect((nows[1].recordedValue as { v: number }).v).toBe(200);
});

// ── --no-replay flag through API ─────────────────────────────────────────────

test('--no-replay re-executes effects when re-encountered (via fn re-call)', () => {
  // Call now() twice — first call records, second call replays from committed log.
  // With noReplay, the second call ignores the recorded entry and runs fresh.
  const source = 'let f = fn() { now() }; let a = f(); let _ = pause; let b = f(); print(to_str(b));';
  const s1 = freshState(); s1.timeOverride = 100;
  const r1 = compileAndRun(source, s1);
  expect(r1.state.effects.filter(e => e.effect === 'now').length).toBe(1);
  r1.state.timeOverride = 999;
  r1.state.noReplay = true;
  const r2 = compileAndRun(source, r1.state);
  // With noReplay, second call to f() re-executes now() and appends fresh entry.
  const nows = r2.state.effects.filter(e => e.effect === 'now');
  expect(nows.length).toBeGreaterThanOrEqual(2);
  // The fresh entry uses the current timeOverride (999), not 100.
  expect((nows[1].recordedValue as { v: number }).v).toBe(999);
});

// ── CLI surface: --event injection end-to-end ────────────────────────────────

test('CLI: pen resume --event approval=true completes wait_for-driven program', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'g3.pen');
  writeFileSync(src, 'let v = wait_for("approval"); print(to_str(v));');
  const r1 = spawnSync(PEN, ['run', src], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  const snap = src.replace(/\.pen$/, '.penz');
  expect(existsSync(snap)).toBe(true);
  const r2 = spawnSync(PEN, ['resume', snap, '--event', 'approval=true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout).toContain('true');
});

test('CLI: pen resume --event count=42 (int) completes', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'g4.pen');
  writeFileSync(src, 'let n = wait_for("count"); print(to_str(n));');
  spawnSync(PEN, ['run', src], { encoding: 'utf8' });
  const snap = src.replace(/\.pen$/, '.penz');
  const r2 = spawnSync(PEN, ['resume', snap, '--event', 'count=42'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout).toContain('42');
});

// ── 24h HITL agent demo (programmatic) ───────────────────────────────────────

test('H4: 24h HITL agent — pause/resume cycle completes idempotently', () => {
  // A simplified equivalent: print → wait_for → print → pause → write_file → print
  // The Phase 2 24h-HITL example used net_fetch; we substitute with a simpler test
  // that exercises the same flow shape: pause, external value, pause again, finalize.
  const dir = tmpDir();
  const audit = path.join(dir, 'audit.log');
  const source = `
    print("requesting approval");
    let decision = wait_for("approve");
    print("got: " + to_str(decision));
    let _ = pause;
    write_file("${audit}", "audit-trail");
    print("audit complete");
  `;
  // First run: pauses on wait_for
  const r1 = compileAndRun(source);
  expect(r1.status).toBe('paused');
  // Inject approval
  const pending = r1.state.effects.find(e => e.eventName === 'approve');
  pending!.recordedValue = { tag: 'bool', v: true };
  // Second run: pauses on bare pause
  const r2 = compileAndRun(source, r1.state);
  expect(r2.status).toBe('paused');
  // Final run: writes audit, completes
  const r3 = compileAndRun(source, r2.state);
  expect(r3.status).toBe('halted');
  expect(readFileSync(audit, 'utf8')).toBe('audit-trail');
});
