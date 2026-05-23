// Penelope effects module.
// Owns real-world IO (HTTP, FS, console, time, RNG) and the effect-name catalog.
// `interpreter.ts` delegates here on first execution of an effect call.
// On replay, `interpreter.ts` reads from the effect log and does NOT call this module.

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
