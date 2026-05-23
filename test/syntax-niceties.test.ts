import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

function execProgram(source: string) {
  return run(compile(parse(tokenize(source))));
}

// ── Negative literals ────────────────────────────────────────────────────────

test('negative integer literal', () => {
  const r = execProgram('let x = -5;');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: -5 });
});

test('unary minus on expression desugars to (0 - expr)', () => {
  const r = execProgram('let x = 10; let y = -x;');
  expect(r.state.frames[0].bindings.y).toEqual({ tag: 'int', v: -10 });
});

test('subtraction still works (not confused with unary)', () => {
  const r = execProgram('let x = 10 - 3;');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 7 });
});

// ── Hex / binary / underscore ────────────────────────────────────────────────

test('hex literal 0xff', () => {
  const r = execProgram('let x = 0xff;');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 255 });
});

test('hex literal upper case 0xFF', () => {
  const r = execProgram('let x = 0xFF;');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 255 });
});

test('binary literal 0b1010', () => {
  const r = execProgram('let x = 0b1010;');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 10 });
});

test('underscore separators in decimal', () => {
  const r = execProgram('let x = 1_000_000;');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 1_000_000 });
});

test('underscore in hex', () => {
  const r = execProgram('let x = 0xff_ff;');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 65535 });
});

// ── Block comments ───────────────────────────────────────────────────────────

test('block comment is stripped', () => {
  const r = execProgram('/* hi */ let x = 1; /* bye */');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 1 });
});

test('block comment can span multiple lines', () => {
  const r = execProgram('let x = 1;\n/* line 1\nline 2\nline 3 */\nlet y = 2;');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 1 });
  expect(r.state.frames[0].bindings.y).toEqual({ tag: 'int', v: 2 });
});

test('unterminated block comment errors', () => {
  expect(() => execProgram('/* never closes')).toThrow(/unterminated block comment/);
});

// ── Unit literal () ──────────────────────────────────────────────────────────

test('unit literal evaluates to unit', () => {
  const r = execProgram('let u = ();');
  expect(r.state.frames[0].bindings.u).toEqual({ tag: 'unit' });
});

test('unit literal works inside fn', () => {
  const r = execProgram('let noop = fn() { () }; let r = noop();');
  expect(r.state.frames[0].bindings.r).toEqual({ tag: 'unit' });
});
