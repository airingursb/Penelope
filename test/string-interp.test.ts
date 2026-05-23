import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

function execProgram(source: string) {
  return run(compile(parse(tokenize(source))));
}

test('plain string (no ${...}) lexes as STRING (not TEMPLATE_STRING)', () => {
  const ts = tokenize('"hello";');
  expect(ts[0].kind).toBe('STRING');
});

test('string with ${...} lexes as TEMPLATE_STRING with parts', () => {
  const ts = tokenize('"hi ${name}";');
  expect(ts[0].kind).toBe('TEMPLATE_STRING');
  expect(ts[0].parts).toEqual([
    { kind: 'text', value: 'hi ' },
    { kind: 'expr', source: 'name' },
    { kind: 'text', value: '' },
  ]);
});

test('single interpolation', () => {
  const r = execProgram('let n = "world"; let s = "hello ${n}"; let result = s;');
  expect(r.state.frames[0].bindings.result).toEqual({ tag: 'str', v: 'hello world' });
});

test('multiple interpolations', () => {
  const r = execProgram('let a = 1; let b = 2; let s = "a=${a}, b=${b}";');
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: 'a=1, b=2' });
});

test('expression interpolation (arithmetic)', () => {
  const r = execProgram('let x = 10; let s = "x+1=${x + 1}";');
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: 'x+1=11' });
});

test('interpolation with function call', () => {
  const r = execProgram('let s = "len=${str_length("abcdef")}";');
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: 'len=6' });
});

test('escaped dollar sign is literal', () => {
  const r = execProgram('let s = "price: \\${42}";');
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: 'price: ${42}' });
});

test('empty interpolation between texts', () => {
  const r = execProgram('let x = 5; let s = "before${x}after";');
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: 'before5after' });
});

test('interpolation with bool value', () => {
  const r = execProgram('let ok = true; let s = "is ok: ${ok}";');
  expect(r.state.frames[0].bindings.s).toEqual({ tag: 'str', v: 'is ok: true' });
});

test('interpolation works in print', () => {
  const r = execProgram('let n = 42; print("answer: ${n}");');
  expect(r.state.effects[0].effect).toBe('print');
});
