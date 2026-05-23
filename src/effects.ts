// Penelope effects module.
// Owns real-world IO (HTTP, FS, console, time, RNG) and the effect-name catalog.
// `interpreter.ts` delegates here on first execution of an effect call.
// On replay, `interpreter.ts` reads from the effect log and does NOT call this module.

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function performWriteFile(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
}

export function performNow(timeOverride: number | null = null): number {
  return timeOverride !== null ? timeOverride : Date.now();
}

export function performRandomInt(lo: number, hi: number): number {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

export function performNetFetch(url: string): string {
  const r = spawnSync('curl', ['-sS', '--fail', '-A', 'Penelope/0.2', url], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`curl exit ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

export type EffectName =
  | 'print'
  | 'net_fetch'
  | 'now'
  | 'random_int'
  | 'read_file'
  | 'write_file'
  | 'wait_until'
  | 'wait_for';

export const EFFECT_NAMES: ReadonlySet<EffectName> = new Set<EffectName>([
  'print', 'net_fetch', 'now', 'random_int',
  'read_file', 'write_file', 'wait_until', 'wait_for',
]);

export type EffectCategory = 'write' | 'read' | 'wait';

export function categoryOf(name: EffectName): EffectCategory {
  if (name === 'print' || name === 'write_file') return 'write';
  if (name === 'net_fetch' || name === 'now' || name === 'random_int' || name === 'read_file') return 'read';
  return 'wait';  // wait_until, wait_for
}
