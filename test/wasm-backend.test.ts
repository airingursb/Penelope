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
// Host imports provided:
//   js.print(ptr, len)        — captures output lines if capturedPrint given
//   js.now()                  — fixed test time (1_700_000_000_000) for determinism
//   js.random_int(lo, hi)     — fixed seed sequence for determinism
async function runWasmMain(bytes: Uint8Array, capturedPrint?: string[]): Promise<number> {
  const mod = await WebAssembly.compile(bytes);
  let randomCount = 0;
  const inst: WebAssembly.Instance = await WebAssembly.instantiate(mod, {
    js: {
      print: (ptr: number, len: number): void => {
        const mem = new Uint8Array((inst.exports.memory as WebAssembly.Memory).buffer);
        const s = new TextDecoder('utf-8').decode(mem.slice(ptr, ptr + len));
        if (capturedPrint) capturedPrint.push(s);
        else process.stdout.write(s + '\n');
      },
      now: (): number => 1_700_000_000,   // a fixed seconds-epoch value for test determinism
      random_int: (lo: number, hi: number): number => {
        randomCount++;
        return lo + (randomCount % Math.max(1, hi - lo + 1));
      },
    },
  });
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

// ── Phase 6.C: strings ──────────────────────────────────────────────────────

test('wasm backend (6.C): str_length of a literal', async () => {
  const source = 'let r = str_length("hello"); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(5);
});

test('wasm backend (6.C): str_length of empty string', async () => {
  const source = 'let r = str_length(""); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(0);
});

test('wasm backend (6.C): string concat via +', async () => {
  const source = 'let s = "hello, " + "world!"; let r = str_length(s); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(13);
});

test('wasm backend (6.C): to_str on positive int', async () => {
  const source = 'let s = to_str(42); let r = str_length(s); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(2);
});

test('wasm backend (6.C): to_str on zero', async () => {
  const source = 'let s = to_str(0); let r = str_length(s); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(1);
});

test('wasm backend (6.C): to_str on negative int', async () => {
  const source = 'let s = to_str(0 - 1234); let r = str_length(s); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(5);   // "-1234"
});

test('wasm backend (6.C): + dispatches int vs str at runtime', async () => {
  const source = 'let a = 10 + 5; let b = "x" + "y"; let r = a + str_length(b); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(17);   // 15 + 2
});

test('wasm backend (6.C): combo — "the answer is: " + to_str(42)', async () => {
  const source = 'let s = "the answer is: " + to_str(42); let r = str_length(s); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(17);
});

// ── Phase 6.G: print via host import ────────────────────────────────────────

test('wasm backend (6.G): print emits to host', async () => {
  const source = 'print("hello from wasm"); 0;';
  const captured: string[] = [];
  const bytes = await penEmitWasm(source);
  await runWasmMain(bytes, captured);
  expect(captured).toEqual(['hello from wasm']);
});

test('wasm backend (6.G): print + to_str compose end-to-end', async () => {
  const source = 'let n = 7; print("n*n = " + to_str(n * n)); 0;';
  const captured: string[] = [];
  const bytes = await penEmitWasm(source);
  await runWasmMain(bytes, captured);
  expect(captured).toEqual(['n*n = 49']);
});

test('wasm backend (6.G): multiple print calls fire in order', async () => {
  const source = 'print("a"); print("b"); print("c"); 0;';
  const captured: string[] = [];
  const bytes = await penEmitWasm(source);
  await runWasmMain(bytes, captured);
  expect(captured).toEqual(['a', 'b', 'c']);
});

test('wasm backend (6.G): print inside a fn', async () => {
  const source = `
    let greet = fn(name) { print("hello, " + name) };
    greet("world");
    greet("penelope");
    0;
  `;
  const captured: string[] = [];
  const bytes = await penEmitWasm(source);
  await runWasmMain(bytes, captured);
  expect(captured).toEqual(['hello, world', 'hello, penelope']);
});

test('wasm backend (6.G): now() returns int from host', async () => {
  const source = 'let t = now(); t;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(1_700_000_000);
});

test('wasm backend (6.G): random_int with fixed seed', async () => {
  const source = 'let r = random_int(10, 19); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(11);   // 10 + (1 % 10) = 11
});

test('wasm backend (6.G): print + now compose', async () => {
  const source = 'print("t=" + to_str(now())); 0;';
  const captured: string[] = [];
  const bytes = await penEmitWasm(source);
  await runWasmMain(bytes, captured);
  expect(captured).toEqual(['t=1700000000']);
});

// ── Phase 6.F: match expressions ────────────────────────────────────────────

test('wasm backend (6.F): match with int literals', async () => {
  const source = `
    let classify = fn(n) {
      match n {
        0 => 100,
        1 => 200,
        2 => 300,
        _ => 999,
      }
    };
    let r = classify(1);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(200);
});

test('wasm backend (6.F): match wildcard fall-through', async () => {
  const source = `
    let f = fn(n) {
      match n {
        0 => 1,
        _ => 0,
      }
    };
    let r = f(42);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(0);
});

test('wasm backend (6.F): match var binding', async () => {
  const source = `
    let describe = fn(n) {
      match n {
        0 => 0,
        x => x + 100,
      }
    };
    let r = describe(7);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(107);
});

test('wasm backend (6.F): match with bool patterns', async () => {
  const source = `
    let onoff = fn(b) {
      match b {
        true => 1,
        false => 0,
      }
    };
    let r = onoff(true);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(1);
});

test('wasm backend (6.F): match unit pattern', async () => {
  const source = `
    let f = fn(u) {
      match u {
        () => 42,
        _ => 0,
      }
    };
    let r = f(());
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(42);
});

test('wasm backend (6.F): nested match', async () => {
  const source = `
    let step = fn(state, input) {
      match state {
        0 => match input {
          1 => 10,
          _ => 0,
        },
        _ => 99,
      }
    };
    let r = step(0, 1);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(10);
});

test('wasm backend (6.F): match negative int literal', async () => {
  const source = `
    let f = fn(n) {
      match n {
        0 => 1000,
        x => x,
      }
    };
    let r = f(0 - 5);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(-5);
});

// ── Phase 6.D: lists (basics) ────────────────────────────────────────────────

test('wasm backend (6.D): list_new + list_len', async () => {
  const source = 'let xs = list_new(10, 20, 30); let r = list_len(xs); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(3);
});

test('wasm backend (6.D): list_new with 0 items', async () => {
  const source = 'let xs = list_new(); let r = list_len(xs); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(0);
});

test('wasm backend (6.D): list_get retrieves element by index', async () => {
  const source = 'let xs = list_new(100, 200, 300, 400); let r = list_get(xs, 2); r;';
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(300);
});

test('wasm backend (6.D): list_push appends + immutable original preserved', async () => {
  const source = `
    let a = list_new(1, 2);
    let b = list_push(a, 3);
    let r = list_get(b, 2) + list_len(a);
    r;
  `;
  const bytes = await penEmitWasm(source);
  // b = [1, 2, 3], list_get(b, 2) = 3; a = [1, 2], list_len(a) = 2 ; sum = 5
  expect(await runWasmMain(bytes)).toBe(5);
});

test('wasm backend (6.D): list with recursive sum', async () => {
  const source = `
    let sum = fn(xs, i) {
      if (i >= list_len(xs)) { 0 }
      else { list_get(xs, i) + sum(xs, i + 1) }
    };
    let xs = list_new(10, 20, 30, 40);
    let r = sum(xs, 0);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(100);
});

test('wasm backend (6.D): list of strings + iteration prints each', async () => {
  const source = `
    let print_each = fn(xs, i) {
      if (i >= list_len(xs)) { 0 }
      else {
        print(list_get(xs, i));
        print_each(xs, i + 1)
      }
    };
    let xs = list_new("alpha", "beta", "gamma");
    print_each(xs, 0);
    0;
  `;
  const captured: string[] = [];
  const bytes = await penEmitWasm(source);
  await runWasmMain(bytes, captured);
  expect(captured).toEqual(['alpha', 'beta', 'gamma']);
});

test('wasm backend (6.D tier-2): list_set replaces at index, original preserved', async () => {
  const source = `
    let a = list_new(1, 2, 3);
    let b = list_set(a, 1, 99);
    let r = list_get(a, 1) + list_get(b, 1);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(101);   // 2 + 99
});

test('wasm backend (6.D tier-2): list_slice picks subrange', async () => {
  const source = `
    let xs = list_new(10, 20, 30, 40, 50);
    let ys = list_slice(xs, 1, 4);
    let r = list_len(ys) * 100 + list_get(ys, 0) + list_get(ys, 2);
    r;
  `;
  const bytes = await penEmitWasm(source);
  // ys = [20, 30, 40]; len*100 + 20 + 40 = 360
  expect(await runWasmMain(bytes)).toBe(360);
});

test('wasm backend (6.D tier-2): list_concat joins two lists', async () => {
  const source = `
    let a = list_new(1, 2);
    let b = list_new(3, 4, 5);
    let c = list_concat(a, b);
    let r = list_len(c) + list_get(c, 4);
    r;
  `;
  const bytes = await penEmitWasm(source);
  // c = [1,2,3,4,5] len=5; get(4)=5; 5+5=10
  expect(await runWasmMain(bytes)).toBe(10);
});

test('wasm backend (6.D tier-2): list_reverse reverses order', async () => {
  const source = `
    let xs = list_new(1, 2, 3, 4);
    let ys = list_reverse(xs);
    let r = list_get(ys, 0) * 1000 + list_get(ys, 1) * 100 + list_get(ys, 2) * 10 + list_get(ys, 3);
    r;
  `;
  const bytes = await penEmitWasm(source);
  // ys = [4, 3, 2, 1]; 4000 + 300 + 20 + 1 = 4321
  expect(await runWasmMain(bytes)).toBe(4321);
});

// ── Phase 6.D: dicts ─────────────────────────────────────────────────────────

test('wasm backend (6.D dicts): dict_new + dict_set + dict_get', async () => {
  const source = `
    let d = dict_set(dict_set(dict_new(), "k", 42), "j", 99);
    let r = dict_get(d, "k");
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(42);
});

test('wasm backend (6.D dicts): dict_set replaces existing key', async () => {
  const source = `
    let d = dict_set(dict_set(dict_set(dict_new(), "n", 1), "n", 2), "n", 3);
    let r = dict_get(d, "n");
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(3);
});

test('wasm backend (6.D dicts): dict_has finds + misses', async () => {
  const source = `
    let d = dict_set(dict_set(dict_new(), "x", 1), "y", 2);
    let r = if (dict_has(d, "x")) { 100 } else { 0 };
    let r2 = if (dict_has(d, "z")) { 10 } else { 0 };
    let total = r + r2;
    total;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(100);
});

test('wasm backend (6.D dicts): dict_keys returns list of keys', async () => {
  const source = `
    let d = dict_set(dict_set(dict_set(dict_new(), "a", 1), "b", 2), "c", 3);
    let ks = dict_keys(d);
    let r = list_len(ks);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(3);
});

test('wasm backend (6.D dicts): dict immutability — old preserved after set', async () => {
  const source = `
    let a = dict_set(dict_new(), "k", 1);
    let b = dict_set(a, "k", 999);
    let r = dict_get(a, "k") + dict_get(b, "k");
    r;
  `;
  const bytes = await penEmitWasm(source);
  // a["k"] = 1; b["k"] = 999; 1 + 999 = 1000
  expect(await runWasmMain(bytes)).toBe(1000);
});

test('wasm backend (6.D dicts): nested dict_get via iteration over keys', async () => {
  const source = `
    let total_values = fn(d, ks, i) {
      if (i >= list_len(ks)) { 0 }
      else { dict_get(d, list_get(ks, i)) + total_values(d, ks, i + 1) }
    };
    let d = dict_set(dict_set(dict_set(dict_new(), "a", 10), "b", 20), "c", 30);
    let ks = dict_keys(d);
    let r = total_values(d, ks, 0);
    r;
  `;
  const bytes = await penEmitWasm(source);
  expect(await runWasmMain(bytes)).toBe(60);
});

test('wasm backend (6.C): memory export — can decode string bytes from heap', async () => {
  const source = 'let s = "hello"; let r = str_length(s); r;';
  const bytes = await penEmitWasm(source);
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod, {
    js: { print: () => {}, now: () => 0, random_int: (lo: number) => lo },
  });
  expect(inst.exports.memory).toBeInstanceOf(WebAssembly.Memory);
  (inst.exports.main as () => number)();
  const mem = new Uint8Array((inst.exports.memory as WebAssembly.Memory).buffer);
  expect(mem.length).toBeGreaterThan(0);
});
