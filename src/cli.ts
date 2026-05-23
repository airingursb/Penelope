// Penelope CLI.
// Subcommands: run, resume, fork, inspect.
// Argv parsing is hand-rolled — Phase 1 has zero dependencies.
//
// NOTE(T28-T30): run/resume/fork/inspect are stubbed here.
// They will be rewired to the VM in T28-T30.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { compile } from './compiler.js';
import { run, freshState } from './vm.js';
import { writePencFile, readPencFile } from './encoder.js';
import { serialize, sha256, deserialize } from './snapshot.js';
import type { Snapshot } from './snapshot.js';
import type { Value } from './ast.js';

// Suppress unused-import warnings during migration (T30 will use these).
void (deserialize as unknown);
void (freshState as unknown);
void (resolve as unknown); void (dirname as unknown); void (basename as unknown); void (join as unknown);

// ============================================================
// Argv parsing
// ============================================================

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | true>;
  events: Record<string, string>;   // ← NEW
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const events: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
  return { positional, flags, events };
}

// ============================================================
// Helpers
// ============================================================

function defaultSnapshotPath(sourcePath: string): string {
  const dir = dirname(sourcePath);
  const base = basename(sourcePath).replace(/\.pen$/, '');
  return join(dir, `${base}.penz`);
}

// Keep defaultSnapshotPath callable to avoid unused-function warning
void (defaultSnapshotPath as unknown);

function parseResumeValue(text: string): Value | { error: string } {
  if (/^-?\d+$/.test(text))   return { tag: 'int', v: Number(text) };
  if (text === 'true')        return { tag: 'bool', v: true };
  if (text === 'false')       return { tag: 'bool', v: false };
  return { error: `cannot parse '${text}' as int or bool` };
}

// Keep parseResumeValue callable to avoid unused-function warning
void (parseResumeValue as unknown);

// ============================================================
// build subcommand (T28)
// ============================================================

function cmdBuild(args: ParsedArgs): number {
  const srcPath = args.positional[1];
  if (!srcPath) {
    process.stderr.write('usage: pen build <file.pen>\n');
    return 2;
  }
  const absSrc = resolve(srcPath);
  let source: string;
  try { source = readFileSync(absSrc, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read source: ${srcPath}\n`); return 3; }

  const tokens = tokenize(source);
  const ast = parse(tokens);
  const prog = compile(ast);
  prog.sourceHash = 'sha256:' + sha256(source);
  const pencPath = absSrc.replace(/\.pen$/, '.penc');
  writePencFile(pencPath, prog);
  process.stdout.write(`wrote ${pencPath} (${prog.code.length} opcodes, ${prog.constants.length} constants)\n`);
  return 0;
}

// ============================================================
// exec subcommand (T29) — run a .penc file directly
// ============================================================

function cmdExec(args: ParsedArgs): number {
  const pencPath = args.positional[1];
  if (!pencPath) {
    process.stderr.write('usage: pen exec <file.penc>\n');
    return 2;
  }
  const absPenc = resolve(pencPath);
  const r = readPencFile(absPenc);
  if ('error' in r) {
    process.stderr.write(`cli error: ${r.error}\n`);
    return 1;
  }
  const result = run(r.prog);
  if (result.status === 'paused') {
    const snapPath = absPenc.replace(/\.penc$/, '.penz');
    const snap = {
      version: 3 as const,
      programPath: absPenc,
      programHash: 'sha256:' + sha256(readFileSync(absPenc, 'utf8')),
      pausedAtIP: result.state.ip,
      pausedAtMs: Date.now(),
      state: result.state,
    };
    writeFileSync(snapPath, serialize(snap));
    process.stdout.write(`paused at ip ${result.state.ip} → ${snapPath}\n`);
  }
  return 0;
}

// ============================================================
// run subcommand
// TODO(T28-T30): rewire to VM
// ============================================================

function cmdRun(_args: ParsedArgs): number {
  process.stderr.write('pen run is being migrated to VM in T28-T30\n');
  process.exit(1);
}

// ============================================================
// resume subcommand
// TODO(T28-T30): rewire to VM
// ============================================================

function cmdResume(_args: ParsedArgs): number {
  process.stderr.write('pen resume is being migrated to VM in T28-T30\n');
  process.exit(1);
}

// ============================================================
// fork subcommand
// TODO(T28-T30): rewire to VM
// ============================================================

function cmdFork(_args: ParsedArgs): number {
  process.stderr.write('pen fork is being migrated to VM in T28-T30\n');
  process.exit(1);
}

// ============================================================
// inspect subcommand
// TODO(T28-T30): rewire to VM
// ============================================================

function cmdInspect(_args: ParsedArgs): number {
  const snapPath = _args.positional[1];
  if (!snapPath) {
    process.stderr.write('usage: penelope inspect <file.penz>\n');
    return 2;
  }

  const absSnapPath = resolve(snapPath);
  let snapJson: string;
  try { snapJson = readFileSync(absSnapPath, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read snapshot: ${snapPath}\n`); return 3; }

  let snap: Snapshot;
  try { snap = JSON.parse(snapJson); }
  catch { process.stderr.write(`cli error: snapshot is corrupted (invalid JSON)\n`); return 3; }

  // Try to read source for hash status (non-fatal if it fails)
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
  out.write(`  Source: ${snap.programPath}  ${sourceStatus}\n`);
  out.write(`  Full path: ${resolve(dirname(absSnapPath), snap.programPath)}\n`);
  out.write(`  Paused at IP: ${snap.pausedAtIP}\n`);
  out.write(`  Time: ${new Date(snap.pausedAtMs).toISOString()} (${ageStr})\n`);
  out.write(`\n`);
  out.write(`Effect log (${snap.state.effects.length} entries):\n`);
  if (snap.state.effects.length === 0) {
    out.write(`  (empty)\n`);
  } else {
    snap.state.effects.forEach((e, idx) => {
      const status = e.status === 'committed' ? '✓' : '⏳';
      const valueStr = e.recordedValue ? JSON.stringify(e.recordedValue) : '(none)';
      out.write(`  ${idx + 1}. [${status}] ${e.effect.padEnd(12)} @ip=${e.ip} #${e.invocationCount}  value=${valueStr}\n`);
    });
  }
  out.write(`\n`);
  out.write(`Value stack (${snap.state.valueStack.length}): `);
  out.write(snap.state.valueStack.map(v => JSON.stringify(v)).join(', ') || '(empty)');
  out.write(`\n`);
  return 0;
}

// ============================================================
// Main
// ============================================================

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const sub = args.positional[0];
  if (sub === 'build')   return cmdBuild(args);
  if (sub === 'exec')    return cmdExec(args);
  if (sub === 'run')     return cmdRun(args);
  if (sub === 'resume')  return cmdResume(args);
  if (sub === 'fork')    return cmdFork(args);
  if (sub === 'inspect') return cmdInspect(args);
  process.stderr.write(`usage: penelope <build|exec|run|resume|fork|inspect> [args]\n`);
  return 2;
}

// Self-invoke when run as a script
process.exit(main(process.argv.slice(2)));
