// The acid test for full self-hosting.
//
// "Round-trip" (self-host-roundtrip.test.ts) proves: pen frontend produces the
// same BYTECODE as TS frontend, for std/*.pen sources. Same opcodes, same
// constants. That's necessary but not sufficient — it could still be the case
// that the pen-built bytecode is malformed in a way that makes it unrunnable.
//
// This test goes one step further. It:
//
//   1. Compiles std/parser.pen + std/compiler.pen via the pen frontend (so we
//      get a Program whose code list was produced ENTIRELY by Penelope-implemented
//      lexer/parser/compiler running on the TS VM).
//   2. Actually runs that Program. It calls pen_compile on a fresh source string
//      and prints the resulting bytecode.
//   3. Compares the printed bytecode against what the TS frontend would produce
//      for the same source.
//
// If steps 1-3 succeed and the outputs match, then the pen frontend can rebuild
// itself from source: tsBuild(penFrontend) ≡ penBuild(penFrontend) at the
// bytecode level AND at the runtime-behavior level.

import { test, expect } from 'vitest';
import { tokenize as tsTokenize } from '../src/lexer.js';
import { parse as tsParse } from '../src/parser.js';
import { compile as tsCompile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { loadSource } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tsCompileBytecode(source: string): { constants: any[]; code: any[][] } {
  const prog = tsCompile(tsParse(tsTokenize(source)));
  return { constants: prog.constants, code: prog.code as any[][] };
}

function normOp(op: any[]): any[] {
  if (op[0] === 'LOAD_VAR') return [op[0], op[1], op[2] ?? null];
  if (op[0] === 'EFFECT') return [op[0], op[1], op[2], op[3] ?? null];
  return op;
}

function programsEqual(a: any, b: any): boolean {
  return JSON.stringify({ c: a.constants, k: a.code.map(normOp) }) ===
         JSON.stringify({ c: b.constants, k: b.code.map(normOp) });
}

// Compile the pen-frontend driver via the pen frontend itself, then run the
// resulting bytecode on the VM. Returns whatever the driver prints.
function runPenBuiltFrontendOn(sourceToCompile: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-acid-'));
  const sourcePath = path.join(dir, 'input.pen.txt');
  writeFileSync(sourcePath, sourceToCompile);

  // Driver: reads sourcePath, runs the pen-implemented frontend on it, prints bytecode.
  // We write the IMPORT-EXPANDED driver to disk so that pen_tokenize sees the full
  // text (with parser.pen + compiler.pen inlined) — pen_parse silently skips
  // `import` statements, so the unexpanded form would lose those definitions.
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
  const driverSource = loadSource(driverPath);
  const expandedDriverPath = path.join(dir, 'driver.expanded.pen');
  writeFileSync(expandedDriverPath, driverSource);

  // Stage 1: TS pipeline compiles the driver → ts_built_driver_prog.
  // We then run THAT prog through the pen frontend (which is what the driver
  // text declares). The output is a Program for sourceToCompile, computed by
  // pen frontend living inside ts_built_driver_prog.
  //
  // Stage 2 (the acid step): rebuild the driver using the PEN frontend instead.
  // To do that without infinite recursion, we use the TS frontend ONE MORE TIME
  // to instantiate the pen frontend, which we then call to compile the driver.
  // That gives us pen_built_driver_prog — a Program produced entirely by Penelope
  // code. Run that, and what we get is sourceToCompile's bytecode computed by a
  // pen frontend that was itself built by a pen frontend. If that matches the TS
  // answer, the bootstrap is mechanically sound.

  // Phase A: instantiate the pen frontend via TS pipeline so we can call its
  // pen_compile on the driver source itself. The result is the pen-built driver
  // Program serialized as JSON to stdout.
  const metaDriver =
    `import "${process.cwd()}/std/parser.pen";\n` +
    `import "${process.cwd()}/std/compiler.pen";\n` +
    `let driver_src = read_file(${JSON.stringify(expandedDriverPath)});\n` +
    `let toks = pen_tokenize(driver_src);\n` +
    `let ast = pen_parse(toks);\n` +
    `let prog = pen_compile(ast);\n` +
    `print(to_str(prog));\n`;
  const metaDriverPath = path.join(dir, 'meta-driver.pen');
  writeFileSync(metaDriverPath, metaDriver);
  const metaDriverSource = loadSource(metaDriverPath);

  // Run the meta-driver via TS pipeline to capture pen-built bytecode for the driver.
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => { captured.push(a.join(' ')); };
  try {
    run(tsCompile(tsParse(tsTokenize(metaDriverSource))));
  } finally {
    console.log = origLog;
  }
  if (captured.length === 0) {
    rmSync(dir, { recursive: true });
    throw new Error('meta-driver printed nothing');
  }
  const penBuiltDriverJson = captured[captured.length - 1];
  const penBuiltDriverProg = JSON.parse(penBuiltDriverJson);

  // Phase B: run that pen-built driver bytecode. It will read sourcePath via the
  // read_file effect, run the pen-implemented frontend on it, and print the
  // resulting bytecode. The pen frontend ITSELF was compiled by pen frontend.
  const captured2: string[] = [];
  console.log = (...a: any[]) => { captured2.push(a.join(' ')); };
  try {
    // The pen-compiled program from JSON has the right structure (constants are
    // Value-shaped, code is opcode arrays). Pass as-is to run().
    run(penBuiltDriverProg);
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true });
  }
  if (captured2.length === 0) throw new Error('pen-built driver printed nothing');
  return captured2[captured2.length - 1];
}

test('acid test: pen-built pen-frontend compiles a literal program', () => {
  const sample = 'let x = 42;';
  const ts = tsCompileBytecode(sample);
  const penOutput = runPenBuiltFrontendOn(sample);
  const pen = JSON.parse(penOutput);
  expect(programsEqual(ts, pen)).toBe(true);
});

test('acid test: pen-built pen-frontend compiles a fn + call', () => {
  const sample = 'let f = fn(n) { n + 1 }; print(to_str(f(41)));';
  const ts = tsCompileBytecode(sample);
  const penOutput = runPenBuiltFrontendOn(sample);
  const pen = JSON.parse(penOutput);
  expect(programsEqual(ts, pen)).toBe(true);
});

test('acid test: pen-built pen-frontend compiles a match expression', () => {
  const sample = 'let r = match 1 { 1 | 2 => "small", n if n > 10 => "big", _ => "mid" };';
  const ts = tsCompileBytecode(sample);
  const penOutput = runPenBuiltFrontendOn(sample);
  const pen = JSON.parse(penOutput);
  expect(programsEqual(ts, pen)).toBe(true);
});

test('acid test: pen-built pen-frontend compiles template strings', () => {
  const sample = 'let n = 7; print("sum = ${n + 1}");';
  const ts = tsCompileBytecode(sample);
  const penOutput = runPenBuiltFrontendOn(sample);
  const pen = JSON.parse(penOutput);
  expect(programsEqual(ts, pen)).toBe(true);
});
