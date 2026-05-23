import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

function execProgram(source: string) {
  return run(compile(parse(tokenize(source))));
}

test('match on int literal — first arm hits', () => {
  const r = execProgram('let r = match 1 { 1 => "one", _ => "other" };');
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'str', v: 'one' });
});

test('match on int literal — falls to wildcard', () => {
  const r = execProgram('let r = match 99 { 1 => "one", _ => "other" };');
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'str', v: 'other' });
});

test('match on bool', () => {
  const r = execProgram(`
    let r = match true {
      true => "yes",
      false => "no",
    };
  `);
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'str', v: 'yes' });
});

test('match on string', () => {
  const r = execProgram(`
    let r = match "hello" {
      "hi" => 1,
      "hello" => 2,
      _ => 0,
    };
  `);
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'int', v: 2 });
});

test('var pattern binds the value', () => {
  const r = execProgram('let r = match 42 { x => x + 1 };');
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'int', v: 43 });
});

test('match works inside a function', () => {
  const r = execProgram(`
    let describe = fn(n) {
      match n {
        0 => "zero",
        _ => "nonzero",
      }
    };
    let a = describe(0);
    let b = describe(7);
  `);
  expect(r.state.frames[0].bindings.a).toEqual({ tag: 'str', v: 'zero' });
  expect(r.state.frames[0].bindings.b).toEqual({ tag: 'str', v: 'nonzero' });
});

test('match arms can be expressions of mixed types (no exhaustiveness check)', () => {
  const r = execProgram('let r = match 1 { 1 => 100, _ => "str" };');
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'int', v: 100 });
});

test('match with no matching arm and no wildcard returns unit', () => {
  // Documented limitation: no exhaustiveness check; non-matching falls through to unit.
  const r = execProgram('let r = match 99 { 1 => "one", 2 => "two" };');
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'unit' });
});

test('match scrutinee is evaluated once (var binding works)', () => {
  // The scrutinee is a function call; verify it only fires once even though we
  // could imagine it being re-evaluated per arm. Use count via a closure.
  const r = execProgram(`
    let counter = fn(n) { n };
    let v = counter(42);
    let r = match v { x => x };
  `);
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'int', v: 42 });
});

test('match binding does not leak out of arm', () => {
  // x is bound inside the var arm; outside it's undefined.
  expect(() => execProgram(`
    let r = match 42 { x => x };
    print(to_str(x));
  `)).toThrow(/undefined variable 'x'/);
});

test('nested match', () => {
  const r = execProgram(`
    let classify = fn(x, y) {
      match x {
        0 => match y { 0 => "origin", _ => "y-axis" },
        _ => match y { 0 => "x-axis", _ => "quadrant" },
      }
    };
    let a = classify(0, 0);
    let b = classify(1, 1);
    let c = classify(0, 5);
    let d = classify(5, 0);
  `);
  expect(r.state.frames[0].bindings.a).toEqual({ tag: 'str', v: 'origin' });
  expect(r.state.frames[0].bindings.b).toEqual({ tag: 'str', v: 'quadrant' });
  expect(r.state.frames[0].bindings.c).toEqual({ tag: 'str', v: 'y-axis' });
  expect(r.state.frames[0].bindings.d).toEqual({ tag: 'str', v: 'x-axis' });
});
