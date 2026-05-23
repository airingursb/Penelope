// Effect inference: every expression has a Type AND an EffectSet. The Fn type
// also carries the effects its body performs. `pure fn(...)` is a hard
// declaration — the checker errors if the body's effect set isn't empty.

import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { checkWithEffects, builtinEffects, type EffectName } from '../src/typecheck.js';

function effectsOfRoot(source: string): Set<EffectName> {
  const ast = parse(tokenize(source));
  const { effects, errors } = checkWithEffects(ast);
  if (errors.length > 0) throw new Error(`unexpected errors: ${errors.map(e => e.message).join('; ')}`);
  return effects.get(ast.rootId) ?? new Set();
}

function errorsOf(source: string): string[] {
  const ast = parse(tokenize(source));
  const { errors } = checkWithEffects(ast);
  return errors.map(e => e.message);
}

// ── Builtin effect catalogue ─────────────────────────────────────────────────

test('builtinEffects: print is io', () => {
  expect([...builtinEffects('print')]).toEqual(['io']);
});

test('builtinEffects: read_file is fs', () => {
  expect([...builtinEffects('read_file')]).toEqual(['fs']);
});

test('builtinEffects: wait_until is pause + time', () => {
  expect([...builtinEffects('wait_until')].sort()).toEqual(['pause', 'time']);
});

test('builtinEffects: str_length is pure', () => {
  expect(builtinEffects('str_length').size).toBe(0);
});

// ── Inference: program-level effect aggregation ──────────────────────────────

test('let with literal is pure', () => {
  expect(effectsOfRoot('let x = 42;').size).toBe(0);
});

test('print(...) registers io', () => {
  expect([...effectsOfRoot('print("hi");')]).toEqual(['io']);
});

test('pause expression registers pause', () => {
  expect([...effectsOfRoot('let _ = pause;')]).toEqual(['pause']);
});

test('multiple effects accumulate', () => {
  const e = effectsOfRoot('print(read_file("/tmp/x")); let n = now();');
  expect([...e].sort()).toEqual(['fs', 'io', 'time']);
});

test('effect inside if branch propagates up', () => {
  const e = effectsOfRoot('let _ = if (true) { print("a") } else { print("b") };');
  expect([...e]).toEqual(['io']);
});

test('effect inside fn body does NOT leak to definition site', () => {
  // Defining a fn is itself pure; only calling it manifests the effect.
  expect(effectsOfRoot('let f = fn() { print("hi") };').size).toBe(0);
});

test('calling a fn that prints DOES manifest io', () => {
  expect([...effectsOfRoot('let f = fn() { print("hi") }; f();')]).toEqual(['io']);
});

// ── pure fn enforcement ──────────────────────────────────────────────────────

test('pure fn with pure body type-checks', () => {
  expect(errorsOf('let f = pure fn(n) { n + 1 };')).toEqual([]);
});

test('pure fn calling print errors', () => {
  const errs = errorsOf('let f = pure fn(n) { print(to_str(n)) };');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/pure fn body has effects \[io\]/);
});

test('pure fn with pause errors', () => {
  const errs = errorsOf('let f = pure fn() { pause };');
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/pure fn body has effects \[pause\]/);
});

test('pure fn calling pure builtin is OK', () => {
  expect(errorsOf('let f = pure fn(s) { str_length(s) };')).toEqual([]);
});

test('pure fn transitively calling effectful fn errors', () => {
  // f1 is impure (calls print). f2 is declared pure but calls f1 → error.
  const errs = errorsOf(`
    let f1 = fn() { print("x") };
    let f2 = pure fn() { f1() };
  `);
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/pure fn body has effects/);
});

test('match arms aggregate effects across arms', () => {
  const e = effectsOfRoot('let r = match 1 { 0 => 0, _ => { print("x"); 1 } };');
  expect([...e]).toEqual(['io']);
});

test('nested fn: outer pure, inner pure — OK', () => {
  expect(errorsOf('let f = pure fn(n) { (pure fn(m) { m * 2 })(n) };')).toEqual([]);
});

test('nested fn: outer pure, inner impure (but never called) — OK', () => {
  // Defining an impure fn inside a pure fn is fine — definition is pure.
  // Only ACTUALLY calling print would make it impure.
  expect(errorsOf('let f = pure fn() { let g = fn() { print("x") }; 1 };')).toEqual([]);
});

test('typeStr shows effects on impure fn', () => {
  const ast = parse(tokenize('let f = fn() { print("x") };'));
  const { types } = checkWithEffects(ast);
  // find the Let's value (the Fn literal)
  const letNode = Object.values(ast.nodes).find(n => n.kind === 'Let' && (n as any).name === 'f') as any;
  const fnType = types.get(letNode.valueId);
  expect(fnType?.kind).toBe('fn');
  if (fnType?.kind !== 'fn') throw new Error('expected fn type');
  expect([...fnType.effects]).toEqual(['io']);
});
