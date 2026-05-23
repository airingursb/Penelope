// Verify the Penelope-implemented lexer (std/lexer.pen) produces tokens that
// match the TS lexer for a variety of Penelope source snippets.

import { test, expect } from 'vitest';
import { tokenize as tsTokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { loadSource } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Run a small driver program that lexes `source` via the pen lexer
// and prints the resulting list of token dicts as a single JSON line.
function penTokenize(source: string): Array<Record<string, any>> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-lex-'));
  const driver = `
    import "${process.cwd()}/std/lexer.pen";
    let toks = pen_tokenize(${JSON.stringify(source)});
    print(to_str(toks));
  `;
  const driverPath = path.join(dir, 'driver.pen');
  writeFileSync(driverPath, driver);
  try {
    // Capture stdout via console.log spy.
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { lines.push(args.join(' ')); };
    try {
      const fullSrc = loadSource(driverPath);
      run(compile(parse(tsTokenize(fullSrc))));
    } finally {
      console.log = origLog;
    }
    if (lines.length === 0) throw new Error('pen lexer printed nothing');
    return JSON.parse(lines[0]);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

// Normalize TS-lexer tokens to the same shape penTokenize returns: drop undefined fields.
function normalizeTs(tokens: ReturnType<typeof tsTokenize>): Array<Record<string, any>> {
  return tokens.map(t => {
    const obj: Record<string, any> = { kind: t.kind, line: t.line, col: t.col };
    if (t.text !== undefined) obj.text = t.text;
    if (t.value !== undefined) obj.value = t.value;
    return obj;
  });
}

// Sort each token's keys for stable comparison.
function sortKeys(t: Record<string, any>): Record<string, any> {
  const sorted: Record<string, any> = {};
  for (const k of Object.keys(t).sort()) sorted[k] = t[k];
  return sorted;
}

function compareLexers(source: string): void {
  const ts = normalizeTs(tsTokenize(source)).map(sortKeys);
  const pen = penTokenize(source).map(sortKeys);
  expect(pen).toEqual(ts);
}

// ── Cases ────────────────────────────────────────────────────────────────────

test('empty source', () => {
  compareLexers('');
});

test('let statement', () => {
  compareLexers('let x = 42;');
});

test('arithmetic with operators', () => {
  compareLexers('let y = 1 + 2 * 3 - 4 / 5;');
});

test('comparison operators', () => {
  compareLexers('let b = 1 < 2; let c = 3 >= 4; let d = 5 == 6; let e = 7 != 8;');
});

test('string literal with escapes', () => {
  compareLexers('let s = "hello\\nworld\\t!";');
});

test('keywords', () => {
  compareLexers('let f = fn(x) { if (x) { true } else { false } };');
});

test('match keyword and FAT_ARROW', () => {
  compareLexers('match x { 1 => "one", _ => "other" };');
});

test('import keyword', () => {
  compareLexers('import "./foo.pen";');
});

test('multi-line preserves line numbers', () => {
  compareLexers('let a = 1;\nlet b = 2;\nlet c = 3;');
});

test('comments are skipped', () => {
  compareLexers('// comment\nlet x = 1; // trailing\nlet y = 2;');
});

test('all punctuation', () => {
  compareLexers('()[]{},;:|');
});
