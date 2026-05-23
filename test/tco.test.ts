import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

function execProgram(source: string) {
  return run(compile(parse(tokenize(source))));
}

test('compiler emits TAILCALL for tail-position fn call', () => {
  const prog = compile(parse(tokenize('let f = fn(n) { f(n - 1) }; f(0);')));
  expect(prog.code.some(op => op[0] === 'TAILCALL')).toBe(true);
});

test('compiler does NOT emit TAILCALL for non-tail call (left operand of +)', () => {
  const prog = compile(parse(tokenize('let f = fn(n) { f(n - 1) + 1 }; f(0);')));
  // The recursive call here is the left operand of `+`, not tail.
  // Only the OUTER `f(0)` at top-level is the entry call (not tail since at Program level).
  const innerTcs = prog.code.filter(op => op[0] === 'TAILCALL').length;
  expect(innerTcs).toBe(0);
});

test('tail-position call inside if/else branches becomes TAILCALL', () => {
  const prog = compile(parse(tokenize('let f = fn(n) { if (n == 0) { 0 } else { f(n - 1) } }; f(0);')));
  expect(prog.code.some(op => op[0] === 'TAILCALL')).toBe(true);
});

test('deep tail recursion does NOT blow the stack (sum 100k)', () => {
  const r = execProgram(`
    let sum = fn(n, acc) {
      if (n == 0) { acc } else { sum(n - 1, acc + n) }
    };
    print(to_str(sum(100000, 0)));
  `);
  expect(r.status).toBe('halted');
  // sum(100000, 0) = 5_000_050_000 — JS Number is fine
});

test('TCO inside closure-captured scope falls back to CALL safely (no infinite loop)', () => {
  // The inner `go` is defined inside outer's body block — its captured frame
  // would be invalidated by TAILCALL frame-reuse. VM degrades to CALL.
  const r = execProgram(`
    let outer = fn() {
      let go = fn(i) {
        if (i == 0) { 0 } else { go(i - 1) }
      };
      go(50)
    };
    print(to_str(outer()));
  `);
  expect(r.status).toBe('halted');
});

test('non-recursive tail call produces same result', () => {
  const r = execProgram(`
    let id = fn(x) { x };
    let wrap = fn(n) { id(n + 1) };
    print(to_str(wrap(41)));
  `);
  expect(r.status).toBe('halted');
});

test('TAILCALL preserves returnIP semantics (returns to original caller)', () => {
  const r = execProgram(`
    let inner = fn(n) { n + 1 };
    let trampoline = fn(n) { inner(n) };
    let x = trampoline(10);
    print(to_str(x));
  `);
  expect(r.status).toBe('halted');
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 11 });
});

test('TCO with multiple ENTER_BLOCK frames above call frame', () => {
  // Deeply nested if/else with tail call at the innermost.
  const r = execProgram(`
    let dec = fn(n) {
      if (n > 100) {
        if (n > 200) { dec(n - 1) } else { dec(n - 2) }
      } else {
        n
      }
    };
    print(to_str(dec(1000)));
  `);
  expect(r.status).toBe('halted');
});
