// Penelope CLI. Phase 3 — bytecode VM.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { compile } from './compiler.js';
import { run, freshState, makeProfile } from './vm.js';
import { writePencFile, readPencFile } from './encoder.js';
import { runOptimizer, type OLevel } from './optimizer.js';
import { check as typeCheck, formatErrors as formatTypeErrors } from './typecheck.js';
import { serialize, sha256, deserialize } from './snapshot.js';
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

function writeSnapshot(pencPath: string, state: VMState): string {
  const snapPath = pencPath.replace(/\.penc$/, '.penz');
  const snap = {
    version: 3 as const,
    programPath: pencPath,
    programHash: 'sha256:' + sha256(readFileSync(pencPath, 'utf8')),
    pausedAtIP: state.ip,
    pausedAtMs: Date.now(),
    state,
  };
  writeFileSync(snapPath, serialize(snap));
  return snapPath;
}

function cmdBuild(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen build [-O0|-O1|-O2] <file.pen>\n'); return 2; }
  const absSrc = resolve(srcPath);
  let source: string;
  try { source = readFileSync(absSrc, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }

  const ast = parse(tokenize(source));
  const prog = runOptimizer(compile(ast), args.oLevel);
  prog.sourceHash = 'sha256:' + sha256(source);
  const pencPath = absSrc.replace(/\.pen$/, '.penc');
  writePencFile(pencPath, prog);
  process.stdout.write(`wrote ${pencPath} (${prog.code.length} opcodes, ${prog.constants.length} constants, -O${args.oLevel})\n`);
  return 0;
}

function cmdExec(args: ParsedArgs): number {
  const pencPath = args.positional[1];
  if (!pencPath) { process.stderr.write('usage: pen exec <file.penc>\n'); return 2; }
  const absPenc = resolve(pencPath);
  const r = readPencFile(absPenc);
  if ('error' in r) { process.stderr.write(`cli error: ${r.error}\n`); return 1; }
  const result = run(r.prog);
  if (result.status === 'paused') {
    const snapPath = writeSnapshot(absPenc, result.state);
    process.stdout.write(`paused at ip ${result.state.ip} → ${snapPath}\n`);
  }
  return 0;
}

function cmdRun(args: ParsedArgs): number {
  const filePath = args.positional[1];
  if (!filePath) { process.stderr.write('usage: pen run [-O0|-O1|-O2] <file.pen> [--time N] [--no-replay]\n'); return 2; }
  const absPath = resolve(filePath);
  let source: string;
  try { source = readFileSync(absPath, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read source: ${filePath}\n`); return 3; }

  const timeFlag = args.flags['time'];
  const timeOverride = timeFlag && timeFlag !== true ? parseInt(String(timeFlag), 10) : null;
  const noReplay = args.flags['no-replay'] === true;

  const ast = parse(tokenize(source));
  const prog = runOptimizer(compile(ast), args.oLevel);

  const state = freshState();
  state.timeOverride = timeOverride;
  state.noReplay = noReplay;

  const r = run(prog, state);

  if (r.status === 'paused') {
    const pencPath = absPath.replace(/\.pen$/, '.penc');
    prog.sourceHash = 'sha256:' + sha256(source);
    writePencFile(pencPath, prog);
    const snapPath = writeSnapshot(pencPath, r.state);
    process.stdout.write(`paused at ip ${r.state.ip} → ${snapPath}\n`);
  }
  return 0;
}

function cmdResume(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  if (!snapPath) { process.stderr.write('usage: pen resume <file.penz> [--time N] [--no-replay]\n'); return 2; }
  const absSnap = resolve(snapPath);
  let snapText: string;
  try { snapText = readFileSync(absSnap, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read snapshot: ${snapPath}\n`); return 3; }

  const sr = deserialize(snapText, (p) => readFileSync(p, 'utf8'));
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
  try { source = readFileSync(resolve(srcPath), 'utf8'); }
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
  return 0;
}

function cmdProfile(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen profile [-O0|-O1|-O2] <file.pen>\n'); return 2; }
  let source: string;
  try { source = readFileSync(resolve(srcPath), 'utf8'); }
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

function cmdCheck(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) { process.stderr.write('usage: pen check <file.pen>\n'); return 2; }
  let source: string;
  try { source = readFileSync(resolve(srcPath), 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }
  const ast = parse(tokenize(source));
  const errs = typeCheck(ast);
  if (errs.length === 0) {
    process.stdout.write(`${srcPath}: ok (no type errors)\n`);
    return 0;
  }
  process.stderr.write(formatTypeErrors(errs) + '\n');
  process.stderr.write(`${errs.length} type error${errs.length === 1 ? '' : 's'}\n`);
  return 1;
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
  let snapJson: string;
  try { snapJson = readFileSync(absSnapPath, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read snapshot: ${snapPath}\n`); return 3; }
  let snap: Snapshot;
  try { snap = JSON.parse(snapJson); }
  catch { process.stderr.write(`cli error: snapshot is corrupted (invalid JSON)\n`); return 3; }

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
  process.stderr.write(`usage: penelope <build|exec|run|resume|fork|disasm|bench|inspect|repl|check|profile> [-O0|-O1|-O2] [args]\n`);
  return 2;
}

main(process.argv.slice(2)).then(code => process.exit(code));
