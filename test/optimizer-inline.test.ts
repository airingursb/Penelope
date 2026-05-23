import { test, expect } from 'vitest';
import { findInliningCandidates, inlinePass } from '../src/optimizer/inline.js';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import type { Program } from '../src/bytecode.js';

// ── T43: candidate detection ─────────────────────────────────────────────────

test('candidate detection: single-use top-level pure fn', () => {
  const ast = parse(tokenize('let f = fn(x) { x + 1 }; f(10);'));
  const prog = compile(ast);
  const cands = findInliningCandidates(prog);
  expect(cands.length).toBe(1);
  expect(cands[0].name).toBe('f');
  expect(cands[0].params).toEqual(['x']);
});

test('candidate rejection: fn body contains EFFECT', () => {
  const ast = parse(tokenize('let f = fn() { print("hi") }; f();'));
  const prog = compile(ast);
  expect(findInliningCandidates(prog).length).toBe(0);
});

test('candidate rejection: fn body contains CALL', () => {
  const ast = parse(tokenize('let g = fn() { 1 }; let f = fn() { g() }; f();'));
  const prog = compile(ast);
  const cands = findInliningCandidates(prog);
  expect(cands.find(c => c.name === 'f')).toBeUndefined();
});

test('candidate rejection: fn used multiple times', () => {
  const ast = parse(tokenize('let f = fn(x) { x + 1 }; f(1); f(2);'));
  const prog = compile(ast);
  expect(findInliningCandidates(prog).length).toBe(0);
});

// ── T44: inline transformation ───────────────────────────────────────────────

test('inlinePass eliminates the call (no CALL, no MAKE_CLOSURE) for single-use pure fn', () => {
  const ast = parse(tokenize('let f = fn(x) { x + 1 }; f(10);'));
  const prog = compile(ast);
  const out = inlinePass(prog);
  expect(out.code.find(op => op[0] === 'CALL')).toBeUndefined();
  expect(out.code.find(op => op[0] === 'MAKE_CLOSURE')).toBeUndefined();
});

test('inlined program runs to halt', () => {
  const ast = parse(tokenize('let f = fn(x) { x + 1 }; f(10);'));
  const prog = compile(ast);
  const out = inlinePass(prog);
  const r = run(out);
  expect(r.status).toBe('halted');
});

// ── T45: semantic equivalence ────────────────────────────────────────────────

test('inlined program produces same effect log as un-inlined', () => {
  const source = 'let f = fn(x) { x + x }; print(to_str(f(7)));';
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  const r0 = run(prog);
  const ri = run(inlinePass(prog));
  expect(r0.status).toBe('halted');
  expect(ri.status).toBe('halted');
  expect(ri.state.effects.map(e => e.recordedValue))
    .toEqual(r0.state.effects.map(e => e.recordedValue));
});

test('program with no inlineable functions is unchanged', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 42 }],
    code: [['LOAD_CONST', 0], ['HALT']],
  };
  const out = inlinePass(prog);
  expect(out).toEqual(prog);
});
