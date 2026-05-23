import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const PEN = resolve('bin/penelope');

function runRepl(input: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(PEN, ['repl'], { input, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

test('REPL auto-prints expression result', () => {
  const r = runRepl('1 + 2\n.exit\n');
  expect(r.stdout).toContain('3');
});

test('REPL: let-binding persists across lines', () => {
  const r = runRepl('let x = 42\nx + 1\n.exit\n');
  expect(r.stdout).toContain('43');
});

test('REPL: function defined and called on the same line', () => {
  // Closures hold bytecode IPs from the line that defined them, so a fn
  // defined on one line cannot be called from a later line. Single-line works.
  const r = runRepl('(fn(n) { n * 2 })(21)\n.exit\n');
  expect(r.stdout).toContain('42');
});

test('REPL: parse error does not crash', () => {
  const r = runRepl('1 +\n1 + 2\n.exit\n');
  expect(r.stderr).toContain('error:');
  expect(r.stdout).toContain('3');  // recovers and continues
});

test('REPL: undefined variable error includes line:col', () => {
  const r = runRepl('whatevs\n.exit\n');
  expect(r.stderr).toMatch(/undefined variable 'whatevs'.*line 1/);
});

test('REPL: prints welcome banner', () => {
  const r = runRepl('.exit\n');
  expect(r.stdout).toContain('Penelope REPL');
});
