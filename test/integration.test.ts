import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PEN = resolve('bin/penelope');

function cleanup(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

test('demo 1: top-level pause survives across processes', () => {
  const source = resolve('examples/01-toplevel-pause.pen');
  const snap = resolve('examples/01-toplevel-pause.penz');
  cleanup(snap);

  // First process: run, hit pause, write snapshot.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);

  // Second process: resume with y = 5, expect 15.
  const r2 = spawnSync(PEN, ['resume', snap, '5'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('15');

  cleanup(snap);
});

test('demo 2: nested-function pause preserves the enclosing call frame', () => {
  const source = resolve('examples/02-nested-pause.pen');
  const snap = resolve('examples/02-nested-pause.penz');
  cleanup(snap);

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);

  // Resume with b = 41; outer should print 42 (a=1 + b=41).
  const r2 = spawnSync(PEN, ['resume', snap, '41'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('42');

  cleanup(snap);
});

test('demo 3: fork produces two independent futures from one snapshot', () => {
  const source = resolve('examples/03-fork.pen');
  const snap = resolve('examples/03-fork.penz');
  const fork0 = resolve('examples/03-fork.fork0.penz');
  const fork1 = resolve('examples/03-fork.fork1.penz');
  cleanup(snap); cleanup(fork0); cleanup(fork1);

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);

  // Fork with 5 and 10; expect both prints.
  const r2 = spawnSync(PEN, ['fork', snap, '5', '10'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);

  const lines = r2.stdout.trim().split('\n').sort();
  expect(lines).toEqual([
    '[fork-0] 105',
    '[fork-1] 110',
  ]);

  cleanup(snap); cleanup(fork0); cleanup(fork1);
});

test('C1/H1: print before pause is not re-printed on resume', () => {
  const source = resolve('examples/04-print-replay.pen');
  const snap = resolve('examples/04-print-replay.penz');
  cleanup(snap);

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(r1.stdout.trim()).toBe('before');
  expect(existsSync(snap)).toBe(true);

  const r2 = spawnSync(PEN, ['resume', snap, '42'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('42');  // "before" must NOT appear

  cleanup(snap);
});

test('F2: write_file skipped on replay (manual override preserved)', () => {
  const source = resolve('/tmp/penelope-wf.pen');
  const snap = resolve('/tmp/penelope-wf.penz');
  const target = '/tmp/penelope-wf-output.txt';
  cleanup(snap); cleanup(target); cleanup(source);

  writeFileSync(source, 'write_file("/tmp/penelope-wf-output.txt", "first"); let _ = pause; print("done");');

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe('first');

  writeFileSync(target, 'manual override');

  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('done');
  expect(readFileSync(target, 'utf8')).toBe('manual override');

  cleanup(source); cleanup(snap); cleanup(target);
});

test('F3: write_file errors propagate first time', () => {
  const source = resolve('/tmp/penelope-wf-err.pen');
  cleanup(source);
  writeFileSync(source, 'write_file("/nonexistent_dir_xyz/file", "x"); print("never");');

  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(1);
  expect(r1.stderr).toMatch(/write_file/);

  cleanup(source);
});
