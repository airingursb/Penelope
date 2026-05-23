// Penelope CLI.
// Subcommands: run, resume, fork, inspect.
// Argv parsing is hand-rolled — Phase 1 has zero dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { initialState, step } from './interpreter.js';
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
// Main
// ============================================================

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const sub = args.positional[0];
  if (sub === 'run')     return cmdRun(args);
  if (sub === 'resume')  return cmdResume(args);
  process.stderr.write(`usage: penelope <run|resume|fork|inspect> [args]\n`);
  return 2;
}

// Self-invoke when run as a script
process.exit(main(process.argv.slice(2)));
