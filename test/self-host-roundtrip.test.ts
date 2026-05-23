// The actual self-hosting acid test: take std/compiler.pen (after TS loader
// expands its imports) and feed it through the Penelope-implemented frontend
// (pen_tokenize → pen_parse → pen_compile). The resulting bytecode must match
// what the TS frontend produces on the same source — modulo inline-cache slots
// that the TS optimizer adds but the pen compiler doesn't.
//
// If this passes for every std/*.pen file, Penelope can rebuild its own
// frontend from source. That's the fixpoint proof.

import { test, expect } from 'vitest';
import { tokenize as tsTokenize } from '../src/lexer.js';
import { parse as tsParse } from '../src/parser.js';
import { compile as tsCompile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { loadSource } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function penCompileViaPenFrontend(source: string): { constants: any[]; code: any[][] } {
  // Driver: pass source via the filesystem (avoids embedding-as-string-literal
  // issues like ${...} being parsed as template interpolation by TS lexer).
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-roundtrip-'));
  const sourcePath = path.join(dir, 'input.pen.txt');
  writeFileSync(sourcePath, source);
  const driver =
    `import "${process.cwd()}/std/parser.pen";\n` +
    `import "${process.cwd()}/std/compiler.pen";\n` +
    `let src = read_file(${JSON.stringify(sourcePath)});\n` +
    `let toks = pen_tokenize(src);\n` +
    `let ast = pen_parse(toks);\n` +
    `let prog = pen_compile(ast);\n` +
    `print(to_str(prog));\n`;
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
    if (lines.length === 0) throw new Error('pen frontend printed nothing');
    return JSON.parse(lines[0]);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function tsCompileSource(source: string): { constants: any[]; code: any[][] } {
  const prog = tsCompile(tsParse(tsTokenize(source)));
  return { constants: prog.constants, code: prog.code as any[][] };
}

function normOp(op: any[]): any[] {
  // pen-compiled ops omit IC slots; TS-compiled ops include them as undefined.
  // Normalize: pad LOAD_VAR / EFFECT to a fixed shape with null for missing slots.
  if (op[0] === 'LOAD_VAR') return [op[0], op[1], op[2] ?? null];
  if (op[0] === 'EFFECT') return [op[0], op[1], op[2], op[3] ?? null];
  return op;
}

function programsEqual(a: any, b: any): boolean {
  return JSON.stringify({ c: a.constants, k: a.code.map(normOp) }) ===
         JSON.stringify({ c: b.constants, k: b.code.map(normOp) });
}

// ── Round-trip the std/*.pen sources themselves ────────────────────────────

const ROUND_TRIP_FILES = [
  'std/iter.pen', 'std/lexer.pen', 'std/parser.pen', 'std/compiler.pen',
  'examples/13-interp.pen',   // template strings
  'examples/14-match.pen',    // nested match + template
];

// Inline source snippets that exercise pattern kinds beyond what the examples cover.
const INLINE_SAMPLES: Array<[string, string]> = [
  ['or-pattern', 'let v = match 2 { 1 | 2 | 3 => "small", _ => "big" };'],
  ['guard', 'let v = match 50 { n if n > 100 => "big", _ => "ok" };'],
  ['list pattern empty', 'let v = match list_new() { [] => "empty", _ => "not" };'],
  ['list pattern fixed', 'let v = match list_new(1, 2) { [a, b] => a + b, _ => 0 };'],
  ['list pattern with rest', 'let v = match list_new(1, 2, 3, 4) { [a, ...t] => list_len(t), _ => 0 };'],
  ['dict pattern', 'let v = match dict_set(dict_new(), "k", 7) { {k: x} => x, _ => 0 };'],
  ['nested match + guard + or', 'let f = fn(n) { match n { 0 | 1 => "small", x if x > 100 => "big", _ => "mid" } }; print(f(50));'],
  ['unit pattern', 'let v = match () { () => "yes", _ => "no" };'],
  ['negative int pattern', 'let v = match -3 { -3 => "neg three", _ => "other" };'],
];

for (const [label, source] of INLINE_SAMPLES) {
  test(`round-trip: ${label}`, () => {
    const ts = tsCompileSource(source);
    const pen = penCompileViaPenFrontend(source);
    if (!programsEqual(ts, pen)) {
      const tsCode = ts.code.map(normOp);
      const penCode = pen.code.map(normOp);
      const len = Math.max(tsCode.length, penCode.length);
      for (let i = 0; i < len; i++) {
        const t = JSON.stringify(tsCode[i]);
        const p = JSON.stringify(penCode[i]);
        if (t !== p) {
          throw new Error(
            `divergence at ip=${i}\n  ts:  ${t}\n  pen: ${p}\n` +
            `ts.constants=${JSON.stringify(ts.constants)}\n` +
            `pen.constants=${JSON.stringify(pen.constants)}`
          );
        }
      }
    }
    expect(programsEqual(ts, pen)).toBe(true);
  });
}

for (const stdFile of ROUND_TRIP_FILES) {
  test(`round-trip: ${stdFile} pen-compiles same as ts-compiles`, () => {
    // TS loader expands imports → single source string.
    const source = loadSource(path.join(process.cwd(), stdFile));
    const ts = tsCompileSource(source);
    const pen = penCompileViaPenFrontend(source);
    if (!programsEqual(ts, pen)) {
      // For diff debugging, dump first divergence
      const tsCode = ts.code.map(normOp);
      const penCode = pen.code.map(normOp);
      const len = Math.max(tsCode.length, penCode.length);
      for (let i = 0; i < len; i++) {
        const t = JSON.stringify(tsCode[i]);
        const p = JSON.stringify(penCode[i]);
        if (t !== p) {
          throw new Error(
            `divergence at ip=${i}\n  ts:  ${t}\n  pen: ${p}\n` +
            `ts.constants.length=${ts.constants.length} pen.constants.length=${pen.constants.length}\n` +
            `ts.code.length=${ts.code.length} pen.code.length=${pen.code.length}`
          );
        }
      }
      expect(ts.constants).toEqual(pen.constants);
    }
    expect(programsEqual(ts, pen)).toBe(true);
  });
}
