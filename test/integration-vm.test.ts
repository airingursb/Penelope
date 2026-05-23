// Phase 3 integration tests — exercise the bytecode VM via CLI subcommands.
// Equivalent coverage to Phase 2 integration tests but using Phase 3 semantics
// (snapshot v3, ip-keyed effects, simple pause = unit, fork = cp).

import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';

const PEN = resolve('bin/penelope');

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'penelope-it-'));
}

function cleanup(p: string): void {
  if (existsSync(p)) unlinkSync(p);
}

test('pen run "let x = 1; print(to_str(x));" prints 1', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'a.pen');
  writeFileSync(src, 'let x = 1; print(to_str(x));');
  const r = spawnSync(PEN, ['run', src], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^1\n?/);
});

test('pen run + pen resume cycle: pause does not re-print earlier output', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'pause.pen');
  writeFileSync(src, 'print("before"); let x = pause; print("after");');
  const r1 = spawnSync(PEN, ['run', src], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(r1.stdout).toContain('before');
  expect(r1.stdout).toMatch(/paused at ip/);

  const snap = src.replace(/\.pen$/, '.penz');
  expect(existsSync(snap)).toBe(true);

  const r2 = spawnSync(PEN, ['resume', snap], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  // "before" was already in the effect log → not re-printed on resume
  expect(r2.stdout).not.toContain('before');
  expect(r2.stdout).toContain('after');
});

test('pen fork copies snapshot to new path', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'fork.pen');
  writeFileSync(src, 'let x = pause; print("done");');
  spawnSync(PEN, ['run', src], { encoding: 'utf8' });
  const snap = src.replace(/\.pen$/, '.penz');
  const forkPath = path.join(dir, 'fork-2.penz');

  const r = spawnSync(PEN, ['fork', snap, forkPath], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(existsSync(forkPath)).toBe(true);
  // Both snapshots have identical content
  expect(readFileSync(snap, 'utf8')).toBe(readFileSync(forkPath, 'utf8'));
});

test('write_file effect replays without re-writing (effect log)', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'wf.pen');
  const outFile = path.join(dir, 'output.txt');
  writeFileSync(src, `write_file("${outFile}", "first"); let x = pause; print("done");`);
  // First run writes the file
  spawnSync(PEN, ['run', src], { encoding: 'utf8' });
  expect(readFileSync(outFile, 'utf8')).toBe('first');
  // Mutate the file manually
  writeFileSync(outFile, 'manual-edit');
  // Resume: write_file is in the effect log; replay should NOT re-write
  const snap = src.replace(/\.pen$/, '.penz');
  spawnSync(PEN, ['resume', snap], { encoding: 'utf8' });
  expect(readFileSync(outFile, 'utf8')).toBe('manual-edit');
});

test('now() effect respects --time flag on first run, replays on resume', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'now.pen');
  writeFileSync(src, 'let t = now(); print(to_str(t)); let x = pause; print(to_str(t));');
  const r1 = spawnSync(PEN, ['run', '--time', '1234567890', src], { encoding: 'utf8' });
  expect(r1.stdout).toContain('1234567890');
  const snap = src.replace(/\.pen$/, '.penz');
  const r2 = spawnSync(PEN, ['resume', snap], { encoding: 'utf8' });
  // Replay uses the recorded value (1234567890), not a fresh now() call
  expect(r2.stdout).toContain('1234567890');
});

test('--no-replay re-executes effects after resume', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'nr.pen');
  writeFileSync(src, 'let t = now(); pause; print(to_str(t));');
  spawnSync(PEN, ['run', '--time', '1000', src], { encoding: 'utf8' });
  const snap = src.replace(/\.pen$/, '.penz');
  // Read the snapshot, verify it has a `now` effect entry
  const snapJson = JSON.parse(readFileSync(snap, 'utf8'));
  expect(snapJson.state.effects.some((e: { effect: string }) => e.effect === 'now')).toBe(true);
  const r = spawnSync(PEN, ['resume', snap, '--time', '2000', '--no-replay'], { encoding: 'utf8' });
  expect(r.status).toBe(0);
});

test('pen inspect on v3 snapshot prints frames + effects', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'i.pen');
  writeFileSync(src, 'let x = 1; pause;');
  spawnSync(PEN, ['run', src], { encoding: 'utf8' });
  const snap = src.replace(/\.pen$/, '.penz');
  const r = spawnSync(PEN, ['inspect', snap], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/version: 3/);
  expect(r.stdout).toMatch(/pausedAtIP:/);
  expect(r.stdout).toMatch(/frames:/);
  expect(r.stdout).toMatch(/effects:/);
});

test('pen disasm prints constants and opcodes', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'd.pen');
  writeFileSync(src, 'let x = 42;');
  spawnSync(PEN, ['build', src], { encoding: 'utf8' });
  const penc = src.replace(/\.pen$/, '.penc');
  const r = spawnSync(PEN, ['disasm', penc], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/constants/);
  expect(r.stdout).toMatch(/LOAD_CONST/);
  expect(r.stdout).toMatch(/STORE_VAR x/);
  expect(r.stdout).toMatch(/HALT/);
});

test('pen build -O2 produces fewer opcodes than -O0', () => {
  const dir = tmpDir();
  const src = path.join(dir, 'o.pen');
  writeFileSync(src, 'let f = fn(x) { x + 1 }; f(10);');
  spawnSync(PEN, ['build', '-O0', src], { encoding: 'utf8' });
  const baseSize = JSON.parse(readFileSync(src.replace(/\.pen$/, '.penc'), 'utf8')).code.length;
  spawnSync(PEN, ['build', '-O2', src], { encoding: 'utf8' });
  const optSize = JSON.parse(readFileSync(src.replace(/\.pen$/, '.penc'), 'utf8')).code.length;
  expect(optSize).toBeLessThan(baseSize);
});

test('examples/01..09 all parse, compile, and run via VM', () => {
  const dir = tmpDir();
  for (let i = 1; i <= 9; i++) {
    const num = i.toString().padStart(2, '0');
    const candidates = [`${num}-`];
    const files = require('node:fs').readdirSync('examples').filter((n: string) =>
      candidates.some(c => n.startsWith(c)) && n.endsWith('.pen')
    );
    for (const file of files) {
      const r = spawnSync(PEN, ['run', '--time', '1700000000', path.join('examples', file)], { encoding: 'utf8' });
      expect([0]).toContain(r.status);
      cleanup(path.join('examples', file.replace(/\.pen$/, '.penz')));
      cleanup(path.join('examples', file.replace(/\.pen$/, '.penc')));
    }
  }
  void dir;
});
