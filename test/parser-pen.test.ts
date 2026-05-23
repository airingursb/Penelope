// Verify std/parser.pen produces ASTs equivalent to the TS parser for a
// variety of Penelope source snippets. Equivalence is checked structurally
// (kind + child shape) rather than node-id identity since the two parsers
// number their nodes independently.

import { test, expect } from 'vitest';
import { tokenize as tsTokenize } from '../src/lexer.js';
import { parse as tsParse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { loadSource } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function penParse(source: string): { rootId: string; nodes: Record<string, any> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-parse-'));
  const driver = `
    import "${process.cwd()}/std/parser.pen";
    let toks = pen_tokenize(${JSON.stringify(source)});
    let ast = pen_parse(toks);
    print(to_str(ast));
  `;
  const driverPath = path.join(dir, 'driver.pen');
  writeFileSync(driverPath, driver);
  try {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => { lines.push(a.join(' ')); };
    try {
      const full = loadSource(driverPath);
      run(compile(tsParse(tsTokenize(full))));
    } finally {
      console.log = origLog;
    }
    if (lines.length === 0) throw new Error('pen parser printed nothing');
    return JSON.parse(lines[0]);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

// Compare two ASTs by their tree shape, walking from root.
// Ignores: node ids, sourcemap positions, the optimizer's IC slots, etc.
function shape(ast: { rootId: string; nodes: Record<string, any> }, id: string): any {
  const node = ast.nodes[id];
  if (!node) return null;
  const out: any = { kind: node.kind };
  // Recursively normalize specific child ID fields by their structural shape.
  for (const key of Object.keys(node).sort()) {
    if (key === 'id' || key === 'pos') continue;
    const v = node[key];
    if (key.endsWith('Id') && typeof v === 'string') {
      out[key.slice(0, -2)] = shape(ast, v);
    } else if (key.endsWith('Ids') && Array.isArray(v)) {
      out[key.slice(0, -3) + 's'] = v.map((cid: string) => shape(ast, cid));
    } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0].bodyId) {
      // match arms: bodyId is a child ref
      out[key] = v.map((arm: any) => ({
        pattern: arm.pattern,
        body: shape(ast, arm.bodyId),
        ...(arm.guardId !== undefined ? { guard: shape(ast, arm.guardId) } : {}),
      }));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function compareParsers(source: string): void {
  const ts = tsParse(tsTokenize(source));
  const pen = penParse(source);
  expect(shape(pen, pen.rootId)).toEqual(shape(ts, ts.rootId));
}

// ── Cases ────────────────────────────────────────────────────────────────────

test('empty program', () => {
  compareParsers('');
});

test('let with int literal', () => {
  compareParsers('let x = 42;');
});

test('arithmetic expression with precedence', () => {
  compareParsers('let y = 1 + 2 * 3;');
});

test('parenthesized expression', () => {
  compareParsers('let y = (1 + 2) * 3;');
});

test('let with bool', () => {
  compareParsers('let b = true;');
});

test('let with string', () => {
  compareParsers('let s = "hello";');
});

test('fn definition', () => {
  compareParsers('let f = fn(x, y) { x + y };');
});

test('fn call', () => {
  compareParsers('let f = fn(x) { x }; let r = f(42);');
});

test('if/else', () => {
  compareParsers('let r = if (true) { 1 } else { 2 };');
});

test('match with literals + wildcard', () => {
  compareParsers('let r = match 1 { 1 => "one", _ => "other" };');
});

test('nested fn + if', () => {
  compareParsers('let f = fn(n) { if (n < 0) { 0 } else { n + 1 } };');
});

test('pause expression', () => {
  compareParsers('let x = pause;');
});

test('unit literal', () => {
  compareParsers('let u = ();');
});

test('negative integer literal', () => {
  compareParsers('let n = -5;');
});

test('comparison operators', () => {
  compareParsers('let a = 1 < 2; let b = 3 == 3; let c = 4 != 5;');
});

test('print call', () => {
  compareParsers('print(to_str(42));');
});

test('block as expression value', () => {
  compareParsers('let x = { let y = 1; y + 1 };');
});
