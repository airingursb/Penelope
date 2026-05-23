// Penelope CLI. Phase 3 — bytecode VM.

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tokenize, tokenizeWithComments } from './lexer.js';
import { parse } from './parser.js';
import { compile } from './compiler.js';
import { run, freshState, makeProfile } from './vm.js';
import { jitCompile } from './jit.js';
import { JsonLinesTracer } from './tracer.js';
import { writePencFile, readPencFile } from './encoder.js';
import { runOptimizer, type OLevel } from './optimizer.js';
import { check as typeCheck, checkWithEffects, typeStr, effectsStr } from './typecheck.js';
import { format as fmtSource } from './format.js';
import { extractDocs, renderMarkdown } from './doc-gen.js';
import { loadSource, loadSourceWithMap } from './loader.js';
import { buildGraph, renderDot } from './graph-gen.js';
import { scaffold } from './scaffold.js';
import { remapState } from './live-edit.js';
import { extractExpectations, checkExpectations } from './test-runner.js';
import { spawnSync } from 'node:child_process';
import { formatDiagnostic, diagnosticFromMessage } from './diagnostic.js';
import { sha256, serializeBytes, deserializeBytes } from './snapshot.js';
import type { Snapshot, VMState } from './snapshot.js';
import type { Value } from './ast.js';

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | true>;
  events: Record<string, string>;
  oLevel: OLevel;
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const events: Record<string, string> = {};
  let oLevel: OLevel = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-O0') { oLevel = 0; continue; }
    if (a === '-O1') { oLevel = 1; continue; }
    if (a === '-O2') { oLevel = 2; continue; }
    if (a === '--event') {
      const next = argv[++i];
      if (!next) throw new Error('--event requires NAME=VALUE');
      const eq = next.indexOf('=');
      if (eq < 0) throw new Error(`--event expects NAME=VALUE, got '${next}'`);
      events[next.slice(0, eq)] = next.slice(eq + 1);
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, events, oLevel };
}

function writeSnapshot(pencPath: string, state: VMState, opts: { compress?: boolean } = {}): string {
  const snapPath = pencPath.replace(/\.penc$/, '.penz');
  const snap = {
    version: 3 as const,
    programPath: pencPath,
    programHash: 'sha256:' + sha256(readFileSync(pencPath, 'utf8')),
    pausedAtIP: state.ip,
    pausedAtMs: Date.now(),
    state,
  };
  // Default: gzip-compress. Older uncompressed .penz files are still readable
  // (deserializeBytes auto-detects gzip vs plain JSON).
  const compress = opts.compress !== false;
  writeFileSync(snapPath, serializeBytes(snap, { compress }));
  return snapPath;
}

// Read a .penz file (auto-detects gzip vs plain JSON, runs the same hash check
// as the legacy text-only path). Pass through to deserializeBytes.
function readSnapshotBytes(snapPath: string, opts: { force?: boolean } = {}) {
  const bytes = readFileSync(snapPath);
  return deserializeBytes(bytes, (p: string) => readFileSync(p, 'utf8'), opts);
}

function cmdBuild(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen build [-O0|-O1|-O2] <file.pen>\n'); return 2; }
  const absSrc = resolve(srcPath);
  let source: string;
  let lineMap: import('./loader.js').LineOrigin[] = [];
  try {
    const loaded = loadSourceWithMap(absSrc);
    source = loaded.source;
    lineMap = loaded.lineMap;
  } catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }

  try {
    const ast = parse(tokenize(source));
    const prog = runOptimizer(compile(ast), args.oLevel);
    prog.sourceHash = 'sha256:' + sha256(source);
    const pencPath = absSrc.replace(/\.pen$/, '.penc');
    writePencFile(pencPath, prog);
    process.stdout.write(`wrote ${pencPath} (${prog.code.length} opcodes, ${prog.constants.length} constants, -O${args.oLevel})\n`);
    return 0;
  } catch (e) {
    const diag = diagnosticFromMessage((e as Error).message, source, srcPath, lineMap);
    process.stderr.write(formatDiagnostic(diag) + '\n');
    return 1;
  }
}

function cmdExec(args: ParsedArgs): number {
  const pencPath = args.positional[1];
  if (!pencPath) { process.stderr.write('usage: pen exec [--jit] <file.penc>\n'); return 2; }
  const absPenc = resolve(pencPath);
  const r = readPencFile(absPenc);
  if ('error' in r) { process.stderr.write(`cli error: ${r.error}\n`); return 1; }
  const useJit = args.flags['jit'] === true || args.flags['jit'] === 'true';
  const result = useJit ? jitCompile(r.prog)(freshState()) : run(r.prog);
  if (result.status === 'paused') {
    const snapPath = writeSnapshot(absPenc, result.state);
    process.stdout.write(`paused at ip ${result.state.ip} → ${snapPath}\n`);
  }
  return 0;
}

function runOnce(absPath: string, filePath: string, args: ParsedArgs): number {
  let source: string;
  let lineMap: import('./loader.js').LineOrigin[] = [];
  try {
    const loaded = loadSourceWithMap(absPath);
    source = loaded.source;
    lineMap = loaded.lineMap;
  } catch { process.stderr.write(`cli error: cannot read source: ${filePath}\n`); return 3; }

  const timeFlag = args.flags['time'];
  const timeOverride = timeFlag && timeFlag !== true ? parseInt(String(timeFlag), 10) : null;
  const noReplay = args.flags['no-replay'] === true;
  const traceEnabled = args.flags['trace'] === true || args.flags['trace'] === 'true';

  try {
    const ast = parse(tokenize(source));
    const prog = runOptimizer(compile(ast), args.oLevel);
    const state = freshState();
    state.timeOverride = timeOverride;
    state.noReplay = noReplay;
    // Tracer writes JSON-lines to stderr when --trace is on. Keeps stdout
    // clean for the program's own output so pipelines aren't disturbed.
    const tracer = traceEnabled ? new JsonLinesTracer(process.stderr) : undefined;
    const r = run(prog, state, undefined, tracer);
    if (r.status === 'paused') {
      const pencPath = absPath.replace(/\.pen$/, '.penc');
      prog.sourceHash = 'sha256:' + sha256(source);
      writePencFile(pencPath, prog);
      const snapPath = writeSnapshot(pencPath, r.state);
      process.stdout.write(`paused at ip ${r.state.ip} → ${snapPath}\n`);
    }
    return 0;
  } catch (e) {
    const diag = diagnosticFromMessage((e as Error).message, source, filePath, lineMap);
    process.stderr.write(formatDiagnostic(diag) + '\n');
    return 1;
  }
}

function cmdRun(args: ParsedArgs): number {
  const filePath = args.positional[1];
  if (!filePath) { process.stderr.write('usage: pen run [-O0|-O1|-O2] [--watch] <file.pen> [--time N] [--no-replay]\n'); return 2; }
  const absPath = resolve(filePath);
  if (args.flags['watch'] === true) {
    return cmdRunWatch(absPath, filePath, args);
  }
  return runOnce(absPath, filePath, args);
}

function cmdRunWatch(absPath: string, filePath: string, args: ParsedArgs): number {
  return watchLoop(absPath, filePath, () => runOnce(absPath, filePath, args));
}

function watchLoop(absPath: string, filePath: string, action: () => number): number {
  const { watch } = require('node:fs');
  const useColor = process.stderr && (process.stderr as { isTTY?: boolean }).isTTY;
  let running = false;
  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  const dim = (s: string) => useColor ? `\x1b[2m${s}\x1b[0m` : s;

  function go() {
    if (running) { pending = true; return; }
    running = true;
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(dim(`watching ${filePath} (Ctrl-C to exit)\n\n`));
    action();
    process.stdout.write(dim(`\n[${new Date().toLocaleTimeString()}] waiting for changes\n`));
    running = false;
    if (pending) { pending = false; setTimeout(go, 50); }
  }

  go();
  watch(absPath, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(go, 100);
  });
  setInterval(() => {}, 1 << 30);
  return 0;
}

function cmdResume(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  if (!snapPath) { process.stderr.write('usage: pen resume <file.penz> [--time N] [--no-replay]\n'); return 2; }
  const absSnap = resolve(snapPath);
  let sr;
  try { sr = readSnapshotBytes(absSnap); }
  catch (e) { process.stderr.write(`cli error: cannot read snapshot: ${(e as Error).message}\n`); return 3; }
  if ('error' in sr) { process.stderr.write(`cli error: ${sr.error}\n`); return 1; }
  if (sr.snap.version !== 3) { process.stderr.write('cli error: snapshot version mismatch (expected 3)\n'); return 1; }

  const pencPath = resolve(dirname(absSnap), sr.snap.programPath);
  const pr = readPencFile(pencPath);
  if ('error' in pr) { process.stderr.write(`cli error: ${pr.error}\n`); return 1; }
  const hashNow = 'sha256:' + sha256(readFileSync(pencPath, 'utf8'));
  if (hashNow !== sr.snap.programHash) {
    process.stderr.write('cli error: program hash mismatch — refusing to resume\n');
    return 1;
  }

  // Inject any --event values into matching wait_for pending entries.
  const state: VMState = sr.snap.state;
  for (const [name, valText] of Object.entries(args.events)) {
    const v = parseResumeValue(valText);
    if ('error' in v) { process.stderr.write(`cli error: ${v.error}\n`); return 1; }
    const entry = state.effects.find(e =>
      e.effect === 'wait_for' && e.status === 'pending' && e.eventName === name);
    if (entry) {
      // Leave status as pending; the VM will promote it to committed when it next executes this ip.
      entry.recordedValue = v;
    } else {
      process.stderr.write(`cli warning: no pending wait_for("${name}") in snapshot\n`);
    }
  }

  const timeFlag = args.flags['time'];
  if (timeFlag && timeFlag !== true) state.timeOverride = parseInt(String(timeFlag), 10);
  if (args.flags['no-replay'] === true) state.noReplay = true;

  const r = run(pr.prog, state);
  if (r.status === 'paused') {
    const newSnapPath = writeSnapshot(pencPath, r.state);
    process.stdout.write(`paused at ip ${r.state.ip} → ${newSnapPath}\n`);
  }
  return 0;
}

function cmdFork(args: ParsedArgs): number {
  const src = args.positional[1];
  const dst = args.positional[2];
  if (!src || !dst) { process.stderr.write('usage: pen fork <src.penz> <dst.penz>\n'); return 2; }
  const absSrc = resolve(src);
  const absDst = resolve(dst);
  if (!existsSync(absSrc)) { process.stderr.write(`cli error: snapshot not found: ${src}\n`); return 3; }
  copyFileSync(absSrc, absDst);
  process.stdout.write(`forked → ${absDst}\n`);
  return 0;
}

function cmdDisasm(args: ParsedArgs): number {
  const pencPath = args.positional[1];
  if (!pencPath) { process.stderr.write('usage: pen disasm <file.penc>\n'); return 2; }
  const r = readPencFile(resolve(pencPath));
  if ('error' in r) { process.stderr.write(`cli error: ${r.error}\n`); return 1; }
  const out = process.stdout;
  out.write(`constants (${r.prog.constants.length}):\n`);
  for (let i = 0; i < r.prog.constants.length; i++) {
    out.write(`  ${i}: ${JSON.stringify(r.prog.constants[i])}\n`);
  }
  out.write(`code (${r.prog.code.length} opcodes):\n`);
  for (let i = 0; i < r.prog.code.length; i++) {
    const op = r.prog.code[i];
    const operands = op.slice(1).map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    out.write(`  ${i.toString().padStart(4, ' ')}: ${op[0]} ${operands}\n`.replace(/ +\n/, '\n'));
  }
  return 0;
}

function cmdBench(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen bench <file.pen>\n'); return 2; }
  let source: string;
  try { source = loadSource(resolve(srcPath)); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  const reps = 3;
  const time = (label: string, fn: () => void) => {
    let total = 0n;
    for (let i = 0; i < reps; i++) {
      const t0 = process.hrtime.bigint();
      fn();
      const t1 = process.hrtime.bigint();
      total += t1 - t0;
    }
    const avgMs = Number(total / BigInt(reps)) / 1e6;
    process.stdout.write(`  ${label.padEnd(25)} avg ${avgMs.toFixed(2)} ms\n`);
  };
  process.stdout.write(`benchmark: ${srcPath} (${reps} reps)\n`);
  time('VM (-O0)',  () => { run(runOptimizer(prog, 0)); });
  time('VM (-O1)',  () => { run(runOptimizer(prog, 1)); });
  time('VM (-O2)',  () => { run(runOptimizer(prog, 2)); });
  // JIT: separate "compile" and "run" timings. The run number reuses the
  // compiled fn across reps — steady-state speed once compilation cost is
  // amortized away. Both compare against the -O2 interpreter above.
  const compiledO2 = runOptimizer(prog, 2);
  const jitFn = jitCompile(compiledO2);   // compile once, time below
  time('JIT compile (-O2)', () => { jitCompile(compiledO2); });
  time('JIT run   (-O2)', () => { jitFn(freshState()); });
  return 0;
}

function testOnce(srcPath: string): number {
  let source: string;
  try { source = loadSource(resolve(srcPath)); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }
  const expects = extractExpectations(source);
  if (expects.length === 0) {
    process.stderr.write(`${srcPath}: no // EXPECT: lines found\n`);
    return 4;
  }
  const penBin = process.argv[1].replace(/[/\\]dist[/\\]cli\.js$/, '/bin/penelope');
  const r = spawnSync(penBin, ['run', srcPath], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`${srcPath}: program exited ${r.status}\n${r.stderr}`);
    return 1;
  }
  const res = checkExpectations(expects, r.stdout);
  if (res.pass) {
    process.stdout.write(`✓ ${srcPath}  (${res.total} expectation${res.total === 1 ? '' : 's'})\n`);
    return 0;
  }
  process.stderr.write(`✗ ${srcPath}  (${res.failed.length}/${res.total} failed)\n`);
  for (const f of res.failed) {
    process.stderr.write(`  line ${f.exp.line}: expected ${f.exp.kind === 'eq' ? '"' + f.exp.text + '"' : 'starts with "' + f.exp.text + '"'}, got ${f.got === undefined ? '<no output>' : '"' + f.got + '"'}\n`);
  }
  return 1;
}

function cmdGraph(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen graph <file.pen>\n'); return 2; }
  const edges = buildGraph(srcPath);
  process.stdout.write(renderDot(srcPath, edges));
  return 0;
}

async function cmdCoordinator(args: ParsedArgs): Promise<number> {
  const { Coordinator } = await import('./dist/coordinator.js');
  const { FileStore, InMemoryStore } = await import('./dist/store.js');
  const port = Number(args.flags['port'] ?? 7077);
  const storeDir = typeof args.flags['store'] === 'string' ? args.flags['store'] as string : null;
  const leaseMs = Number(args.flags['lease-ms'] ?? 5000);
  const store = storeDir ? new FileStore(storeDir) : new InMemoryStore();
  const coord = new Coordinator({ store, port, leaseMs });
  await coord.start();
  process.stdout.write(`pen coordinator listening on http://localhost:${port}  store=${storeDir ?? '(in-memory)'}  leaseMs=${leaseMs}\n`);
  // Keep process alive until SIGINT/SIGTERM.
  await new Promise<void>(resolve => {
    const shutdown = async () => { await coord.stop(); resolve(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

async function cmdWorker(args: ParsedArgs): Promise<number> {
  const { Worker } = await import('./dist/worker.js');
  const { randomUUID } = await import('node:crypto');
  const coordUrl = typeof args.flags['coord'] === 'string' ? args.flags['coord'] as string : 'http://localhost:7077';
  const workerId = typeof args.flags['id'] === 'string' ? args.flags['id'] as string : `worker-${randomUUID().slice(0, 8)}`;
  const worker = new Worker({ workerId, coordUrl });
  await worker.start();
  process.stdout.write(`pen worker ${workerId} → ${coordUrl}\n`);
  await new Promise<void>(resolve => {
    const shutdown = async () => { await worker.stop(); resolve(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

async function cmdSubmit(args: ParsedArgs): Promise<number> {
  const { submitJob, awaitJob } = await import('./dist/worker.js');
  const { freshState } = await import('./vm.js');
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen submit [--coord URL] [--wait] <file.pen>\n'); return 2; }
  const coordUrl = typeof args.flags['coord'] === 'string' ? args.flags['coord'] as string : 'http://localhost:7077';
  const source = loadSource(resolve(srcPath));
  const prog = compile(parse(tokenize(source)));
  const state = freshState();
  const jobId = await submitJob(coordUrl, prog, state);
  process.stdout.write(`submitted job ${jobId}\n`);
  if (args.flags['wait']) {
    const result = await awaitJob(coordUrl, jobId, 60000);
    process.stdout.write(`status: ${result.status}\n`);
    if (result.result) {
      process.stdout.write(`bindings: ${JSON.stringify(result.result.frames[0]?.bindings ?? {})}\n`);
    }
    return result.status === 'completed' ? 0 : 1;
  }
  return 0;
}

// Compile a .pen source to a WASM module via the Penelope-implemented backend
// (std/wasm.pen). The backend handles the int-only subset of Penelope — see
// std/wasm.pen for the precise scope. Writes a .wasm file alongside the source
// (or to -o PATH). The output can be loaded by any WebAssembly runtime.
function cmdWasm(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen wasm <file.pen> [--out FILE]\n'); return 2; }
  const absSrc = resolve(srcPath);
  const outPath = typeof args.flags['out'] === 'string'
    ? resolve(args.flags['out'] as string)
    : absSrc.replace(/\.pen$/, '.wasm');

  // Driver: invoke the pen-implemented backend on the user's source. Use
  // read_file (not source embedding) to avoid template-string parsing pitfalls.
  const tmpDir = join(process.cwd(), `.pen-wasm-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const driverPath = join(tmpDir, 'driver.pen');
  try {
    const driver =
      `import "${resolve('std/parser.pen')}";\n` +
      `import "${resolve('std/wasm.pen')}";\n` +
      `let src = read_file(${JSON.stringify(absSrc)});\n` +
      `print(to_str(pen_to_wasm(pen_parse(pen_tokenize(src)))));\n`;
    writeFileSync(driverPath, driver);
    const expanded = loadSource(driverPath);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => { lines.push(a.join(' ')); };
    try {
      run(compile(parse(tokenize(expanded))));
    } finally {
      console.log = origLog;
    }
    if (lines.length === 0) {
      process.stderr.write('cli error: pen-implemented backend produced no output\n');
      return 1;
    }
    const bytes = JSON.parse(lines[lines.length - 1]) as number[];
    writeFileSync(outPath, Buffer.from(bytes));
    process.stdout.write(`wrote ${outPath} (${bytes.length} bytes)\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`cli error: ${(e as Error).message}\n`);
    return 1;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function cmdSelfTest(_args: ParsedArgs): number {
  // Three-stage self-hosting verification:
  //
  //   Stage 1 — Round-trip: ts_compile(source) ≡ pen_compile(source) on a
  //             battery of samples plus every std/*.pen file. Proves the pen
  //             frontend emits the same bytecode as the TS frontend.
  //
  //   Stage 2 — Self-bootstrap: the pen frontend (parser.pen + compiler.pen),
  //             when compiled by ts AND when compiled by pen, produces byte-
  //             identical bytecode. (Implied by stage 1 on std/*.pen.)
  //
  //   Stage 3 — Acid test (fixpoint): compile the pen frontend with the pen
  //             frontend; run THAT bytecode; have it compile a source; verify
  //             the output matches what TS produces directly. Proves pen-built
  //             bytecode is not just byte-identical but actually runnable.
  const parserPath = resolve('std/parser.pen');
  const compilerPath = resolve('std/compiler.pen');
  if (!existsSync(parserPath) || !existsSync(compilerPath)) {
    process.stderr.write(`self-test: std/parser.pen or std/compiler.pen not found (cwd=${process.cwd()})\n`);
    return 2;
  }

  const normOp = (op: any[]): any[] => {
    if (op[0] === 'LOAD_VAR') return [op[0], op[1], op[2] ?? null];
    if (op[0] === 'EFFECT') return [op[0], op[1], op[2], op[3] ?? null];
    return op;
  };
  const sameBytecode = (a: any, b: any): boolean =>
    JSON.stringify({ c: a.constants, k: a.code.map(normOp) }) ===
    JSON.stringify({ c: b.constants, k: b.code.map(normOp) });

  const samples = [
    'let x = 42;',
    'let f = fn(n) { n + 1 }; print(to_str(f(41)));',
    'let r = if (1 < 2) { "yes" } else { "no" };',
    'let r = match 1 { 1 | 2 => "small", n if n > 100 => "big", _ => "mid" };',
    'let n = 7; print("sum 1..${n} = ${n * (n + 1) / 2}");',
  ];
  const stdFiles = ['std/iter.pen', 'std/lexer.pen', 'std/parser.pen', 'std/compiler.pen'];

  const tmpDir = join(process.cwd(), `.pen-self-test-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const runDriver = (driverSrc: string): string => {
    const driverPath = join(tmpDir, 'driver.pen');
    writeFileSync(driverPath, driverSrc);
    const expanded = loadSource(driverPath);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { lines.push(args.join(' ')); };
    try {
      run(compile(parse(tokenize(expanded))));
    } finally {
      console.log = origLog;
    }
    return lines[lines.length - 1] ?? '';
  };
  const penCompile = (source: string): any => {
    const inputPath = join(tmpDir, 'input.pen.txt');
    writeFileSync(inputPath, source);
    const driver =
      `import "${parserPath}";\nimport "${compilerPath}";\n` +
      `let src = read_file(${JSON.stringify(inputPath)});\n` +
      `print(to_str(pen_compile(pen_parse(pen_tokenize(src)))));\n`;
    return JSON.parse(runDriver(driver) || '{}');
  };

  let pass = 0, fail = 0;
  const fail1 = (label: string): void => { fail++; process.stderr.write(`  ✗ ${label}\n`); };
  const ok1 = (label: string): void => { pass++; process.stdout.write(`  ✓ ${label}\n`); };

  try {
    process.stdout.write(`\nStage 1: round-trip on inline samples\n`);
    for (const s of samples) {
      const ts = compile(parse(tokenize(s)));
      try {
        const pen = penCompile(s);
        sameBytecode(ts, pen) ? ok1(JSON.stringify(s)) : fail1(JSON.stringify(s));
      } catch (e) { fail1(`${JSON.stringify(s)} — ${(e as Error).message}`); }
    }

    process.stdout.write(`\nStage 2: round-trip on std/*.pen (self-bootstrap)\n`);
    for (const f of stdFiles) {
      try {
        const source = loadSource(resolve(f));
        const ts = compile(parse(tokenize(source)));
        const pen = penCompile(source);
        sameBytecode(ts, pen) ? ok1(f) : fail1(f);
      } catch (e) { fail1(`${f} — ${(e as Error).message}`); }
    }

    process.stdout.write(`\nStage 3: acid test — pen-built pen-frontend compiles a program\n`);
    for (const s of samples.slice(0, 3)) {
      try {
        // Build the driver, expand its imports, write expanded form.
        const inputPath = join(tmpDir, 'acid-input.pen.txt');
        writeFileSync(inputPath, s);
        const driver =
          `import "${parserPath}";\nimport "${compilerPath}";\n` +
          `let src = read_file(${JSON.stringify(inputPath)});\n` +
          `print(to_str(pen_compile(pen_parse(pen_tokenize(src)))));\n`;
        const driverPath = join(tmpDir, 'acid-driver.pen');
        writeFileSync(driverPath, driver);
        const expanded = loadSource(driverPath);
        const expandedPath = join(tmpDir, 'acid-driver.expanded.pen');
        writeFileSync(expandedPath, expanded);
        // Phase A: TS compiles the pen frontend, runs it on the driver → pen-built driver bytecode.
        const metaDriver =
          `import "${parserPath}";\nimport "${compilerPath}";\n` +
          `let drv = read_file(${JSON.stringify(expandedPath)});\n` +
          `print(to_str(pen_compile(pen_parse(pen_tokenize(drv)))));\n`;
        const penBuiltDriverProg = JSON.parse(runDriver(metaDriver) || '{}');
        // Phase B: run the pen-built driver bytecode.
        const lines: string[] = [];
        const origLog = console.log;
        console.log = (...args: any[]) => { lines.push(args.join(' ')); };
        try { run(penBuiltDriverProg); } finally { console.log = origLog; }
        const penResult = JSON.parse(lines[lines.length - 1] || '{}');
        const tsResult = compile(parse(tokenize(s)));
        sameBytecode(tsResult, penResult) ? ok1(JSON.stringify(s)) : fail1(JSON.stringify(s));
      } catch (e) { fail1(`${JSON.stringify(s)} — ${(e as Error).message}`); }
    }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  process.stdout.write(`\n${pass}/${pass + fail} checks passed — `);
  if (fail === 0) {
    process.stdout.write(`Penelope self-hosts ✓\n`);
    return 0;
  }
  process.stdout.write(`self-host BROKEN\n`);
  return 1;
}

function cmdEdit(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  if (!snapPath) { process.stderr.write('usage: pen edit <file.penz>\n'); return 2; }
  const absSnap = resolve(snapPath);

  let sr;
  try { sr = readSnapshotBytes(absSnap); }
  catch (e) { process.stderr.write(`cli error: cannot read snapshot: ${(e as Error).message}\n`); return 3; }
  if ('error' in sr) { process.stderr.write(`cli error: ${sr.error}\n`); return 1; }
  if (sr.snap.version !== 3) { process.stderr.write('cli error: snapshot version mismatch\n'); return 1; }

  // Load the OLD bytecode (with its sourceMap) — referenced by snapshot.programPath.
  const oldPencPath = resolve(dirname(absSnap), sr.snap.programPath);
  const oldR = readPencFile(oldPencPath);
  if ('error' in oldR) { process.stderr.write(`cli error: ${oldR.error}\n`); return 1; }

  // Derive the source path from .penc → .pen.
  const srcPath = oldPencPath.replace(/\.penc$/, '.pen');
  let source: string;
  let lineMap: import('./loader.js').LineOrigin[] = [];
  try {
    const loaded = loadSourceWithMap(srcPath);
    source = loaded.source;
    lineMap = loaded.lineMap;
  } catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }

  // Recompile.
  let newProg;
  try {
    const ast = parse(tokenize(source));
    newProg = runOptimizer(compile(ast), args.oLevel);
    newProg.sourceHash = 'sha256:' + sha256(source);
  } catch (e) {
    const diag = diagnosticFromMessage((e as Error).message, source, srcPath, lineMap);
    process.stderr.write(formatDiagnostic(diag) + '\n');
    return 1;
  }

  // Attempt to remap the VMState.
  const remap = remapState(oldR.prog, newProg, sr.snap.state);
  if (!remap.ok) {
    process.stderr.write(`cli error: cannot apply live edit: ${remap.reason}\n`);
    process.stderr.write('hint: revert your changes or use `pen resume` on the old .penc.\n');
    return 1;
  }

  // Write new .penc (overwriting the old) and resume.
  writePencFile(oldPencPath, newProg);
  const r = run(newProg, remap.state);
  if (r.status === 'paused') {
    const newSnapPath = writeSnapshot(oldPencPath, r.state);
    process.stdout.write(`re-paused at ip ${r.state.ip} → ${newSnapPath}\n`);
  } else {
    // halted — remove the snapshot since the program is done
    process.stdout.write('program completed after live edit\n');
  }
  return 0;
}

function cmdNew(args: ParsedArgs): number {
  const dir = args.positional[1];
  if (!dir) { process.stderr.write('usage: pen new <dir>\n'); return 2; }
  const r = scaffold(dir);
  if (r.error) { process.stderr.write(`cli error: ${r.error}\n`); return 1; }
  process.stdout.write(`created ${dir}/\n`);
  for (const f of r.created) {
    process.stdout.write(`  ${f.replace(resolve('.') + '/', '')}\n`);
  }
  process.stdout.write(`\nnext:\n  cd ${dir}\n  pen run main.pen\n`);
  return 0;
}

function cmdDoc(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen doc <file.pen>\n'); return 2; }
  let source: string;
  try { source = loadSource(resolve(srcPath)); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }
  try {
    const { tokens, comments } = tokenizeWithComments(source);
    const ast = parse(tokens);
    const entries = extractDocs(ast, comments);
    process.stdout.write(renderMarkdown(srcPath, entries));
    return 0;
  } catch (e) {
    const diag = diagnosticFromMessage((e as Error).message, source, srcPath);
    process.stderr.write(formatDiagnostic(diag) + '\n');
    return 1;
  }
}

function cmdTest(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen test [--watch] <file.pen>\n'); return 2; }
  if (args.flags['watch'] === true) {
    return watchLoop(resolve(srcPath), srcPath, () => testOnce(srcPath));
  }
  return testOnce(srcPath);
}

function cmdFmt(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen fmt [--write] <file.pen>\n'); return 2; }
  let source: string;
  try { source = loadSource(resolve(srcPath)); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }
  try {
    const { tokens, comments } = tokenizeWithComments(source);
    const ast = parse(tokens);
    const formatted = fmtSource(ast, { comments });
    if (args.flags['write'] === true) {
      writeFileSync(resolve(srcPath), formatted);
      process.stdout.write(`formatted ${srcPath}\n`);
    } else {
      process.stdout.write(formatted);
    }
    return 0;
  } catch (e) {
    const diag = diagnosticFromMessage((e as Error).message, source, srcPath);
    process.stderr.write(formatDiagnostic(diag) + '\n');
    return 1;
  }
}

function cmdProfile(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen profile [-O0|-O1|-O2] <file.pen>\n'); return 2; }
  let source: string;
  try { source = loadSource(resolve(srcPath)); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }
  const ast = parse(tokenize(source));
  const prog = runOptimizer(compile(ast), args.oLevel);
  const profile = makeProfile();
  run(prog, undefined, profile);
  const totalMs = Number(profile.totalNs) / 1e6;
  const out = process.stdout;
  out.write(`profile: ${srcPath}  (-O${args.oLevel}, ${totalMs.toFixed(2)} ms)\n\n`);
  // Per-opcode hot table
  out.write('opcode counts (top 20):\n');
  const ops = Object.entries(profile.opcodeCount).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const totalOps = ops.reduce((s, [, n]) => s + n, 0);
  for (const [name, count] of ops) {
    const pct = totalOps > 0 ? (count / totalOps * 100).toFixed(1) : '0.0';
    out.write(`  ${name.padEnd(16)} ${String(count).padStart(8)}  ${pct.padStart(5)}%\n`);
  }
  out.write(`  ${''.padEnd(16)} ${String(totalOps).padStart(8)}  total opcodes executed\n`);
  // Per-ip hot table (top 10)
  out.write('\nhot ips (top 10):\n');
  const ips = Object.entries(profile.ipCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [ipStr, count] of ips) {
    const ip = parseInt(ipStr, 10);
    const op = prog.code[ip];
    const pos = prog.sourceMap?.[ip];
    const posStr = pos ? `line ${pos.line} col ${pos.col}` : '(no pos)';
    out.write(`  ip ${String(ip).padStart(4)}  ${String(count).padStart(8)}×  ${op[0].padEnd(14)} ${posStr}\n`);
  }
  return 0;
}

function checkOnce(srcPath: string): number {
  let source: string;
  try { source = loadSource(resolve(srcPath)); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }
  let errs;
  try {
    const ast = parse(tokenize(source));
    errs = typeCheck(ast);
  } catch (e) {
    const diag = diagnosticFromMessage((e as Error).message, source, srcPath);
    process.stderr.write(formatDiagnostic(diag) + '\n');
    return 1;
  }
  if (errs.length === 0) {
    process.stdout.write(`${srcPath}: ok (no type errors)\n`);
    return 0;
  }
  for (const err of errs) {
    process.stderr.write(formatDiagnostic({
      message: err.message,
      pos: err.pos,
      source,
      filename: srcPath,
    }) + '\n\n');
  }
  process.stderr.write(`${errs.length} type error${errs.length === 1 ? '' : 's'}\n`);
  return 1;
}

function cmdCheck(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen check [--watch] [--show-effects] <file.pen>\n'); return 2; }
  if (args.flags['show-effects']) {
    return showEffects(srcPath);
  }
  if (args.flags['watch'] === true) {
    return watchLoop(resolve(srcPath), srcPath, () => checkOnce(srcPath));
  }
  return checkOnce(srcPath);
}

// `pen check --show-effects <file>`: type-check the file, then print every
// fn binding with its inferred type + effect set. Useful for spotting which
// helpers are accidentally impure.
function showEffects(srcPath: string): number {
  let source: string;
  try { source = loadSource(resolve(srcPath)); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }
  const ast = parse(tokenize(source));
  const { errors, types, effects } = checkWithEffects(ast);
  if (errors.length > 0) {
    for (const err of errors) {
      process.stderr.write(formatDiagnostic({
        message: err.message,
        pos: err.pos,
        source,
        filename: srcPath,
      }) + '\n\n');
    }
    return 1;
  }
  // Walk Let bindings whose value is a Fn — those are the fns the user named.
  const lines: string[] = [];
  for (const node of Object.values(ast.nodes)) {
    if (node.kind !== 'Let') continue;
    const val = ast.nodes[node.valueId];
    if (val.kind !== 'Fn') continue;
    const t = types.get(node.valueId);
    if (!t || t.kind !== 'fn') continue;
    const lineCol = node.pos ? `${node.pos.line.toString().padStart(4)}:${node.pos.col.toString().padStart(2)}` : '   ?: ?';
    const pure = (val as any).isPure ? '[pure] ' : '';
    lines.push(`  ${lineCol}  ${pure}${node.name} : ${typeStr(t)}`);
  }
  // Program-level effects (the whole file's net effect).
  const rootEff = effects.get(ast.rootId);
  process.stdout.write(`${srcPath}: ok\n\nProgram effects: ${rootEff ? effectsStr(rootEff) : 'pure'}\n\nFn bindings:\n`);
  for (const l of lines) process.stdout.write(l + '\n');
  if (lines.length === 0) process.stdout.write('  (no fn bindings)\n');
  return 0;
}

async function cmdRepl(_args: ParsedArgs): Promise<number> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'pen> ' });
  const state = freshState();
  process.stdout.write('Penelope REPL. Type expressions, statements, or .exit to leave.\n');
  process.stdout.write('Bindings persist across lines. Expressions get auto-printed.\n\n');
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === '' ) { rl.prompt(); continue; }
    if (line === '.exit' || line === '.quit') break;
    try {
      const source = wrapForRepl(line);
      const ast = parse(tokenize(source));
      const prog = compile(ast);
      state.ip = 0;
      state.valueStack = [];
      // Keep frames so let-bindings accumulate; reset effects so the log doesn't grow forever.
      state.effects = [];
      const r = run(prog, state);
      if (r.status === 'paused') {
        process.stdout.write('(paused — REPL ignores pause; line dropped)\n');
        state.ip = 0;
      }
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
    }
    rl.prompt();
  }
  rl.close();
  process.stdout.write('\n');
  return 0;
}

function wrapForRepl(line: string): string {
  // If the line ends in `;` or `}`, treat verbatim. Otherwise wrap as `print(to_str(<line>));`
  // so the user sees the value of a bare expression.
  const trimmed = line.replace(/\s+$/, '');
  if (trimmed.endsWith(';') || trimmed.endsWith('}')) return trimmed;
  // Detect "let ..." or other statement keywords — leave alone, append `;`.
  if (/^\s*(let|fn|if)\b/.test(trimmed)) return trimmed + ';';
  // Otherwise, treat as expression → auto-print.
  return `print(to_str(${trimmed}));`;
}

function cmdInspect(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  if (!snapPath) { process.stderr.write('usage: pen inspect <file.penz>\n'); return 2; }
  const absSnapPath = resolve(snapPath);
  // Auto-detects gzip; the (p) → readFileSync resolver isn't used here because we
  // skip the source-hash check (this is `inspect`, just shows metadata).
  let snap: Snapshot;
  try {
    const result = readSnapshotBytes(absSnapPath, { force: true });
    if ('error' in result) {
      process.stderr.write(`cli error: ${result.error}\n`); return 3;
    }
    snap = result.snap;
  } catch (e) {
    process.stderr.write(`cli error: cannot read snapshot: ${(e as Error).message}\n`); return 3;
  }

  let sourceStatus = '? source missing';
  try {
    const source = readFileSync(resolve(dirname(absSnapPath), snap.programPath), 'utf8');
    const actual = 'sha256:' + sha256(source);
    sourceStatus = (actual === snap.programHash) ? '✓ source matches' : '✗ source stale';
  } catch { /* keep sourceStatus as missing */ }

  const ageMs = Date.now() - snap.pausedAtMs;
  const ageSec = Math.floor(ageMs / 1000);
  const ageStr = ageSec < 60 ? `${ageSec}s ago`
    : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago`
    : `${Math.floor(ageSec / 3600)}h ago`;

  const out = process.stdout;
  out.write(`Snapshot: ${basename(absSnapPath)}\n`);
  out.write(`  version: ${snap.version}\n`);
  out.write(`  programPath: ${snap.programPath}  ${sourceStatus}\n`);
  out.write(`  programHash: ${snap.programHash}\n`);
  out.write(`  pausedAtIP: ${snap.pausedAtIP}\n`);
  out.write(`  pausedAtMs: ${snap.pausedAtMs}  (${ageStr})\n`);
  out.write(`\nframes: ${snap.state.frames.length}\n`);
  snap.state.frames.forEach((f, i) => {
    const keys = Object.keys(f.bindings).join(', ');
    const parent = f.parentIdx !== undefined ? ` parentIdx=${f.parentIdx}` : '';
    out.write(`  [${i}] bindings: { ${keys} }${parent}\n`);
  });
  out.write(`\neffects: ${snap.state.effects.length} entries\n`);
  if (snap.state.effects.length === 0) {
    out.write(`  (empty)\n`);
  } else {
    snap.state.effects.forEach((e, idx) => {
      const status = e.status === 'committed' ? '✓' : '⏳';
      const valueStr = e.recordedValue ? JSON.stringify(e.recordedValue) : '(none)';
      out.write(`  [${idx}] ${status} ${e.effect.padEnd(12)} ip=${e.ip} #${e.invocationCount} value=${valueStr}\n`);
    });
  }
  out.write(`\nvalue stack (${snap.state.valueStack.length}): `);
  out.write(snap.state.valueStack.map((v: Value) => JSON.stringify(v)).join(', ') || '(empty)');
  out.write('\n');
  return 0;
}

function parseResumeValue(text: string): Value | { error: string } {
  if (/^-?\d+$/.test(text))   return { tag: 'int', v: Number(text) };
  if (text === 'true')        return { tag: 'bool', v: true };
  if (text === 'false')       return { tag: 'bool', v: false };
  if (text.startsWith('"') && text.endsWith('"')) return { tag: 'str', v: text.slice(1, -1) };
  return { error: `cannot parse '${text}' as int, bool, or quoted string` };
}

void (parseResumeValue as unknown);
void (join as unknown);

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const sub = args.positional[0];
  if (sub === 'build')   return cmdBuild(args);
  if (sub === 'exec')    return cmdExec(args);
  if (sub === 'run')     return cmdRun(args);
  if (sub === 'resume')  return cmdResume(args);
  if (sub === 'fork')    return cmdFork(args);
  if (sub === 'disasm')  return cmdDisasm(args);
  if (sub === 'bench')   return cmdBench(args);
  if (sub === 'inspect') return cmdInspect(args);
  if (sub === 'repl')    return await cmdRepl(args);
  if (sub === 'check')   return cmdCheck(args);
  if (sub === 'profile') return cmdProfile(args);
  if (sub === 'fmt')     return cmdFmt(args);
  if (sub === 'test')    return cmdTest(args);
  if (sub === 'doc')     return cmdDoc(args);
  if (sub === 'graph')   return cmdGraph(args);
  if (sub === 'new')     return cmdNew(args);
  if (sub === 'edit')    return cmdEdit(args);
  if (sub === 'self-test') return cmdSelfTest(args);
  if (sub === 'coordinator') return await cmdCoordinator(args);
  if (sub === 'worker') return await cmdWorker(args);
  if (sub === 'submit') return await cmdSubmit(args);
  if (sub === 'wasm') return cmdWasm(args);
  process.stderr.write(`usage: penelope <build|exec|run|resume|fork|disasm|bench|inspect|repl|check|profile|fmt|test|doc|graph|new|edit|self-test|coordinator|worker|submit|wasm> [-O0|-O1|-O2] [args]\n`);
  return 2;
}

main(process.argv.slice(2)).then(code => process.exit(code));
