// WASM backend (std/wasm.pen) end-to-end test.
//
// Pipeline tested:
//   .pen source
//     → TS loader (expand imports of std/parser.pen + std/wasm.pen + driver)
//     → TS frontend (tokenize/parse/compile) producing the DRIVER program
//     → TS VM runs the driver, which itself uses the pen-implemented frontend
//       (pen_tokenize/pen_parse) plus pen_to_wasm to emit a WASM byte list
//     → JSON.parse the printed list
//     → Uint8Array
//     → WebAssembly.compile + instantiate
//     → call exported "main"
//     → compare to result of running the original .pen via the TS interpreter
//
// If both numbers match, the pen-implemented WASM backend is correct for the
// program. The matching is the meaningful assertion — same source produces
// equivalent behavior through two completely different execution paths.

import { test, expect } from 'vitest';
import { tokenize as tsTokenize } from '../src/lexer.js';
import { parse as tsParse } from '../src/parser.js';
import { compile as tsCompile } from '../src/compiler.js';
import { run, freshState } from '../src/vm.js';
import { loadSource } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Run a pen source through the pen-implemented WASM emitter and return the
// resulting bytes as a Uint8Array.
async function penEmitWasm(source: string): Promise<Uint8Array> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-wasm-'));
  const sourcePath = path.join(dir, 'input.pen.txt');
  writeFileSync(sourcePath, source);

  // Driver: reads sourcePath, runs pen-implemented frontend + wasm.pen, prints
  // the resulting byte list. We use read_file rather than embedding the source
  // as a JSON literal — embedding hits the ${...} template-string corner the
  // self-host roundtrip tests warned us about.
  const driver =
    `import "${process.cwd()}/std/parser.pen";\n` +
    `import "${process.cwd()}/std/wasm.pen";\n` +
    `let src = read_file(${JSON.stringify(sourcePath)});\n` +
    `let toks = pen_tokenize(src);\n` +
    `let ast = pen_parse(toks);\n` +
    `let bytes = pen_to_wasm(ast);\n` +
    `print(to_str(bytes));\n`;
  const driverPath = path.join(dir, 'driver.pen');
  writeFileSync(driverPath, driver);

  const full = loadSource(driverPath);
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => { lines.push(a.join(' ')); };
  try {
    run(tsCompile(tsParse(tsTokenize(full))));
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true });
  }
  if (lines.length === 0) throw new Error('pen wasm emitter printed nothing');
  const printed = lines[lines.length - 1];
  // Penelope's to_str on a list of ints emits `[1, 2, 3, ...]`. JSON-parseable.
  const arr = JSON.parse(printed) as number[];
  return new Uint8Array(arr);
}

// Run a pen source through the TS interpreter and grab the value of a named
// binding (or the printed output for an ExprStmt-final program).
function tsRunForBinding(source: string, bindingName: string): number {
  const r = run(tsCompile(tsParse(tsTokenize(source))), freshState());
  const v = r.state.frames[0].bindings[bindingName];
  if (!v || v.tag !== 'int') throw new Error(`expected int binding '${bindingName}', got ${JSON.stringify(v)}`);
  return v.v;
}

// Instantiate a WASM module and call its exported "main", return the int result.
async function runWasmMain(bytes: Uint8Array): Promise<number> {
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod, {});
  const main = inst.exports.main as () => number;
  return main();
}

// ─────────────────────────────────────────────────────────────────────────────

test('wasm backend: trivial main returning a literal', async () => {
  const source = 'let r = 42; r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(tsRunForBinding(source, 'r'));
});

test('wasm backend: arithmetic expression', async () => {
  const source = 'let r = (10 + 5) * 2 - 7; r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(tsRunForBinding(source, 'r'));   // 23
});

test('wasm backend: if/else expression', async () => {
  const source = 'let n = 7; let r = if (n < 10) { n * 2 } else { n }; r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(tsRunForBinding(source, 'r'));   // 14
});

test('wasm backend: fn call', async () => {
  const source = `
    let square = fn(n) { n * n };
    let r = square(7);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(tsRunForBinding(source, 'r'));   // 49
});

test('wasm backend: recursive fib', async () => {
  const source = `
    let fib = fn(n) {
      if (n < 2) { n } else { fib(n - 1) + fib(n - 2) }
    };
    let r = fib(15);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(tsRunForBinding(source, 'r'));   // 610
});

test('wasm backend: factorial (recursive)', async () => {
  const source = `
    let fact = fn(n) {
      if (n < 2) { 1 } else { n * fact(n - 1) }
    };
    let r = fact(10);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(tsRunForBinding(source, 'r'));   // 3628800
});

test('wasm backend: mutual recursion', async () => {
  const source = `
    let is_even = fn(n) {
      if (n == 0) { 1 } else { is_odd(n - 1) }
    };
    let is_odd = fn(n) {
      if (n == 0) { 0 } else { is_even(n - 1) }
    };
    let r = is_even(20);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(tsRunForBinding(source, 'r'));   // 1
});

test('wasm backend: bool returned as 0/1', async () => {
  const source = `
    let cmp = fn(a, b) { a < b };
    let r = if (cmp(3, 5)) { 100 } else { 200 };
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(tsRunForBinding(source, 'r'));   // 100
});

test('wasm backend: emitted module is valid (round-trip via WebAssembly.validate)', async () => {
  const bytes = await penEmitWasm('let r = 1; r;');
  expect(WebAssembly.validate(bytes)).toBe(true);
});
