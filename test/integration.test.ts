import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
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
