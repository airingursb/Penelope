// Penelope CLI.
// Subcommands: run, resume, fork, inspect.
// Argv parsing is hand-rolled — Phase 1 has zero dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { initialState, step, formatValue } from './interpreter.js';
import type { State, StepResult } from './interpreter.js';
import { serialize, sha256, deserialize } from './snapshot.js';
import type { Snapshot } from './snapshot.js';
import type { ASTBundle } from './ast.js';
import type { Value } from './ast.js';

// ============================================================
// Argv parsing
// ============================================================

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | true>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
  return { positional, flags };
}

// ============================================================
// Helpers
// ============================================================

function defaultSnapshotPath(sourcePath: string): string {
  const dir = dirname(sourcePath);
  const base = basename(sourcePath).replace(/\.pen$/, '');
  return join(dir, `${base}.penz`);
}

function loop(state: State, ast: ASTBundle): StepResult {
  let s = state;
  while (true) {
    const r = step(s, ast);
    if (r.kind === 'continue') { s = r.state; continue; }
    return r;
  }
}

function parseResumeValue(text: string): Value | { error: string } {
  if (/^-?\d+$/.test(text))   return { tag: 'int', v: Number(text) };
  if (text === 'true')        return { tag: 'bool', v: true };
  if (text === 'false')       return { tag: 'bool', v: false };
  return { error: `cannot parse '${text}' as int or bool` };
}

// ============================================================
// run subcommand
// ============================================================

function cmdRun(args: ParsedArgs): number {
  const sourcePath = args.positional[1];   // [0] is "run"
  if (!sourcePath) {
    process.stderr.write('usage: penelope run <file.pen>\n');
    return 2;
  }

  const absSourcePath = resolve(sourcePath);
  let source: string;
  try {
    source = readFileSync(absSourcePath, 'utf8');
  } catch {
    process.stderr.write(`cli error: cannot read source file: ${sourcePath}\n`);
    return 3;
  }

  let ast: ASTBundle;
  try {
    ast = parse(tokenize(source));
  } catch (e) {
    process.stderr.write(`parse error: ${(e as Error).message}\n`);
    return 1;
  }

  const result = loop(initialState(ast.rootId), ast);

  if (result.kind === 'done') {
    return 0;
  }
  if (result.kind === 'error') {
    const at = result.atNode ? ` at ${result.atNode}` : '';
    process.stderr.write(`runtime error${at}: ${result.message}\n`);
    return 1;
  }
  if (result.kind === 'paused') {
    const outPath = typeof args.flags.out === 'string'
      ? args.flags.out
      : defaultSnapshotPath(absSourcePath);

    const snap: Snapshot = {
      version: 1,
      programPath: basename(absSourcePath),
      programHash: 'sha256:' + sha256(source),
      pausedAt: result.pausedAt,
      pausedAtMs: Date.now(),
      state: result.state,
    };
    writeFileSync(outPath, serialize(snap));
    if (!args.flags.quiet) {
      process.stderr.write(`paused at ${result.pausedAt}; snapshot → ${outPath}\n`);
    }
    return 0;
  }
  return 1;
}

// ============================================================
// resume subcommand
// ============================================================

function cmdResume(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  const valueText = args.positional[2];
  if (!snapPath || valueText === undefined) {
    process.stderr.write('usage: penelope resume <file.penz> <value> [--source <path>] [--force] [--out <path>]\n');
    return 2;
  }

  const absSnapPath = resolve(snapPath);
  let snapJson: string;
  try {
    snapJson = readFileSync(absSnapPath, 'utf8');
  } catch {
    process.stderr.write(`cli error: cannot read snapshot: ${snapPath}\n`);
    return 3;
  }

  const sourceOverride = typeof args.flags.source === 'string' ? args.flags.source : null;
  const resolveSource = (programPath: string): string => {
    const sourcePath = sourceOverride
      ? resolve(sourceOverride)
      : resolve(dirname(absSnapPath), programPath);
    return readFileSync(sourcePath, 'utf8');
  };

  const dr = deserialize(snapJson, resolveSource, { force: !!args.flags.force });
  if ('error' in dr) {
    process.stderr.write(`cli error: ${dr.error}\n`);
    return 3;
  }

  const v = parseResumeValue(valueText);
  if ('error' in v) {
    process.stderr.write(`cli error: ${v.error}\n`);
    return 2;
  }

  const ast = parse(tokenize(dr.source));

  // Inject resume value onto valueStack, then continue stepping.
  const resumedState: State = {
    ...dr.snap.state,
    valueStack: [...dr.snap.state.valueStack, v],
  };
  const result = loop(resumedState, ast);

  if (result.kind === 'done') return 0;
  if (result.kind === 'error') {
    process.stderr.write(`runtime error: ${result.message}\n`);
    return 1;
  }
  if (result.kind === 'paused') {
    const outPath = typeof args.flags.out === 'string'
      ? args.flags.out
      : absSnapPath;  // default: overwrite input
    const newSnap: Snapshot = {
      version: 1,
      programPath: dr.snap.programPath,
      programHash: dr.snap.programHash,
      pausedAt: result.pausedAt,
      pausedAtMs: Date.now(),
      state: result.state,
    };
    writeFileSync(outPath, serialize(newSnap));
    if (!args.flags.quiet) {
      process.stderr.write(`paused again at ${result.pausedAt}; snapshot → ${outPath}\n`);
    }
    return 0;
  }
  return 1;
}

// ============================================================
// fork subcommand
// ============================================================

function cmdFork(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  const v1text = args.positional[2];
  const v2text = args.positional[3];
  if (!snapPath || v1text === undefined || v2text === undefined) {
    process.stderr.write('usage: penelope fork <file.penz> <v1> <v2> [--out1 <path>] [--out2 <path>]\n');
    return 2;
  }

  const absSnapPath = resolve(snapPath);
  let snapJson: string;
  try { snapJson = readFileSync(absSnapPath, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read snapshot: ${snapPath}\n`); return 3; }

  const resolveSource = (programPath: string): string =>
    readFileSync(resolve(dirname(absSnapPath), programPath), 'utf8');

  const dr = deserialize(snapJson, resolveSource, { force: !!args.flags.force });
  if ('error' in dr) { process.stderr.write(`cli error: ${dr.error}\n`); return 3; }

  const v1 = parseResumeValue(v1text);
  if ('error' in v1) { process.stderr.write(`cli error: ${v1.error}\n`); return 2; }
  const v2 = parseResumeValue(v2text);
  if ('error' in v2) { process.stderr.write(`cli error: ${v2.error}\n`); return 2; }

  const ast = parse(tokenize(dr.source));

  const baseDir = dirname(absSnapPath);
  const baseName = basename(absSnapPath).replace(/\.penz$/, '');
  const out1 = typeof args.flags.out1 === 'string'
    ? args.flags.out1
    : join(baseDir, `${baseName}.fork0.penz`);
  const out2 = typeof args.flags.out2 === 'string'
    ? args.flags.out2
    : join(baseDir, `${baseName}.fork1.penz`);

  const runFork = (label: string, injected: Value, outPath: string): number => {
    const origLog = console.log;
    console.log = (msg: string) => origLog(`[${label}] ${msg}`);
    try {
      // Deep clone via JSON — the axiom in action: state is just data
      const cloned: State = JSON.parse(JSON.stringify(dr.snap.state));
      const state: State = {
        ...cloned,
        valueStack: [...cloned.valueStack, injected],
      };
      const result = loop(state, ast);
      if (result.kind === 'error') {
        process.stderr.write(`[${label}] runtime error: ${result.message}\n`);
        return 1;
      }
      if (result.kind === 'paused') {
        const newSnap: Snapshot = {
          version: 1,
          programPath: dr.snap.programPath,
          programHash: dr.snap.programHash,
          pausedAt: result.pausedAt,
          pausedAtMs: Date.now(),
          state: result.state,
        };
        writeFileSync(outPath, serialize(newSnap));
        if (!args.flags.quiet) {
          process.stderr.write(`[${label}] paused again; snapshot → ${outPath}\n`);
        }
      }
      return 0;
    } finally {
      console.log = origLog;
    }
  };

  const c1 = runFork('fork-0', v1, out1);
  const c2 = runFork('fork-1', v2, out2);
  return (c1 === 0 && c2 === 0) ? 0 : 1;
}

// ============================================================
// inspect subcommand
// ============================================================

function cmdInspect(args: ParsedArgs): number {
  const snapPath = args.positional[1];
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
  out.write(`  Paused at: ${snap.pausedAt}\n`);
  out.write(`  Time: ${new Date(snap.pausedAtMs).toISOString()} (${ageStr})\n`);
  out.write(`\n`);
  out.write(`Scopes:\n`);
  for (const [sid, sc] of Object.entries(snap.state.scopes)) {
    const parent = sc.parentId ? ` ← ${sc.parentId}` : '';
    const binds = Object.entries(sc.bindings).map(([n, v]) => `${n}=${formatValue(v)}`).join(', ');
    out.write(`  ${sid}${parent}: { ${binds} }\n`);
  }
  out.write(`Current scope: ${snap.state.currentScopeId}\n`);
  out.write(`\n`);
  out.write(`Control stack (top → bottom, ${snap.state.control.length} instr):\n`);
  for (let i = snap.state.control.length - 1; i >= 0; i--) {
    out.write(`  ${snap.state.control.length - i}. ${JSON.stringify(snap.state.control[i])}\n`);
  }
  out.write(`\n`);
  out.write(`Value stack (${snap.state.valueStack.length}): `);
  out.write(snap.state.valueStack.map(formatValue).join(', ') || '(empty)');
  out.write(`\n`);
  return 0;
}

// ============================================================
// Main
// ============================================================

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const sub = args.positional[0];
  if (sub === 'run')     return cmdRun(args);
  if (sub === 'resume')  return cmdResume(args);
  if (sub === 'fork')    return cmdFork(args);
  if (sub === 'inspect') return cmdInspect(args);
  process.stderr.write(`usage: penelope <run|resume|fork|inspect> [args]\n`);
  return 2;
}

// Self-invoke when run as a script
process.exit(main(process.argv.slice(2)));
