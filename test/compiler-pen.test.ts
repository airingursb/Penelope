// Verify std/compiler.pen produces a Program that matches the TS compiler's
// (constants pool + opcode list) for a variety of Penelope source snippets.
// This is the self-hosting bootstrap proof: Penelope compiles Penelope to
// byte-identical bytecode.

import { test, expect } from 'vitest';
import { tokenize as tsTokenize } from '../src/lexer.js';
import { parse as tsParse } from '../src/parser.js';
import { compile as tsCompile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { loadSource } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function penCompile(source: string): { version: number; constants: any[]; code: any[][] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-comp-'));
  const driver = `
    import "${process.cwd()}/std/parser.pen";
    import "${process.cwd()}/std/compiler.pen";
    let toks = pen_tokenize(${JSON.stringify(source)});
    let ast = pen_parse(toks);
    let prog = pen_compile(ast);
    print(to_str(prog));
  `;
  const driverPath = path.join(dir, 'driver.pen');
  writeFileSync(driverPath, driver);
  try {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => { lines.push(a.join(' ')); };
    try {
      const full = loadSource(driverPath);
      run(tsCompile(tsParse(tsTokenize(full))));
    } finally {
      console.log = origLog;
    }
    if (lines.length === 0) throw new Error('pen compiler printed nothing');
    return JSON.parse(lines[0]);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

// Compare TS and pen-produced programs ignoring fields the pen compiler
// doesn't emit (sourceMap, sourceHash). The TS compiler uses -O0 since
// the pen compiler has no optimizer.
function compareCompilers(source: string): void {
  // The TS compiler always emits a sourceMap. Strip it for comparison.
  const ts = tsCompile(tsParse(tsTokenize(source)));
  const pen = penCompile(source);
  expect(pen.constants).toEqual(ts.constants);
  // Normalize opcodes: pen lacks the ic-slot (undefined where TS has null).
  const tsOps = ts.code.map(normOp);
  const penOps = pen.code.map(normOp);
  expect(penOps).toEqual(tsOps);
}

function normOp(op: any[]): any[] {
  // For LOAD_VAR and EFFECT, the trailing IC slot might be null or undefined; treat as equal.
  if (op[0] === 'LOAD_VAR') return [op[0], op[1], op[2] ?? null];
  if (op[0] === 'EFFECT') return [op[0], op[1], op[2], op[3] ?? null];
  return op;
}

// ── Cases ────────────────────────────────────────────────────────────────────

test('let with int literal', () => {
  compareCompilers('let x = 42;');
});

test('arithmetic', () => {
  compareCompilers('let x = 1 + 2;');
});

test('precedence', () => {
  compareCompilers('let x = 1 + 2 * 3;');
});

test('let with string', () => {
  compareCompilers('let s = "hello";');
});

test('fn defn', () => {
  compareCompilers('let f = fn(x) { x + 1 };');
});

test('fn call', () => {
  compareCompilers('let f = fn(x) { x + 1 }; let r = f(10);');
});

test('if/else', () => {
  compareCompilers('let r = if (true) { 1 } else { 2 };');
});

test('match with literals + wildcard', () => {
  compareCompilers('let r = match 1 { 1 => "one", _ => "other" };');
});

test('print effect call', () => {
  compareCompilers('print("hi");');
});

test('pure builtin call', () => {
  compareCompilers('let n = str_length("hello");');
});

test('pause', () => {
  compareCompilers('let x = pause;');
});

test('unit literal', () => {
  compareCompilers('let u = ();');
});

test('nested if + fn', () => {
  compareCompilers('let f = fn(n) { if (n < 0) { 0 } else { n + 1 } }; let r = f(5);');
});

test('full round-trip end-to-end: pen-compiled program runs correctly', () => {
  const source = 'let f = fn(n) { n + 1 }; print(to_str(f(41)));';
  const pen = penCompile(source);
  // Feed the pen-produced Program directly to the VM and verify the print fires with "42".
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => { lines.push(a.join(' ')); };
  try {
    run(pen as any);
  } finally {
    console.log = origLog;
  }
  expect(lines[lines.length - 1]).toBe('42');
});
