import { test, expect } from 'vitest';
import { buildGraph, renderDot } from '../src/graph-gen.js';
import { scaffold } from '../src/scaffold.js';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'pen-graph-'));
}

// ── pen graph ────────────────────────────────────────────────────────────────

test('buildGraph: single file with no imports → empty edge list', () => {
  const d = tmp();
  writeFileSync(path.join(d, 'a.pen'), 'let x = 1;');
  expect(buildGraph(path.join(d, 'a.pen'))).toEqual([]);
  rmSync(d, { recursive: true });
});

test('buildGraph: single import becomes one edge', () => {
  const d = tmp();
  writeFileSync(path.join(d, 'lib.pen'), 'let helper = 1;');
  writeFileSync(path.join(d, 'main.pen'), 'import "./lib.pen";');
  const edges = buildGraph(path.join(d, 'main.pen'), d);
  expect(edges).toHaveLength(1);
  expect(edges[0].from).toBe('main.pen');
  expect(edges[0].to).toBe('lib.pen');
  rmSync(d, { recursive: true });
});

test('buildGraph: transitive imports', () => {
  const d = tmp();
  writeFileSync(path.join(d, 'c.pen'), 'let z = 3;');
  writeFileSync(path.join(d, 'b.pen'), 'import "./c.pen";\nlet y = 2;');
  writeFileSync(path.join(d, 'a.pen'), 'import "./b.pen";');
  const edges = buildGraph(path.join(d, 'a.pen'), d);
  expect(edges.map(e => `${e.from}→${e.to}`)).toEqual([
    'a.pen→b.pen',
    'b.pen→c.pen',
  ]);
  rmSync(d, { recursive: true });
});

test('renderDot includes node defaults and one edge per pair', () => {
  const dot = renderDot('root.pen', [
    { from: 'root.pen', to: 'a.pen' },
    { from: 'root.pen', to: 'a.pen' },   // dup ignored
    { from: 'a.pen', to: 'b.pen' },
  ]);
  expect(dot).toContain('digraph Penelope');
  expect(dot).toContain('"root.pen" -> "a.pen"');
  expect(dot).toContain('"a.pen" -> "b.pen"');
  // Dup filtered:
  expect(dot.split('"root.pen" -> "a.pen"').length).toBe(2);
});

// ── pen new ──────────────────────────────────────────────────────────────────

test('scaffold creates directory with main.pen, README, .gitignore', () => {
  const d = path.join(os.tmpdir(), 'pen-new-' + Date.now());
  const r = scaffold(d);
  expect(r.error).toBeUndefined();
  expect(existsSync(path.join(d, 'main.pen'))).toBe(true);
  expect(existsSync(path.join(d, 'README.md'))).toBe(true);
  expect(existsSync(path.join(d, '.gitignore'))).toBe(true);
  expect(readFileSync(path.join(d, 'main.pen'), 'utf8')).toContain('print(');
  rmSync(d, { recursive: true });
});

test('scaffold refuses to overwrite an existing directory', () => {
  const d = tmp();
  const r = scaffold(d);
  expect(r.error).toMatch(/already exists/);
  rmSync(d, { recursive: true });
});

test('scaffolded main.pen runs without error', async () => {
  const d = path.join(os.tmpdir(), 'pen-new-run-' + Date.now());
  scaffold(d);
  // Smoke test: tokenize+parse+compile+run via the same pipeline
  const { tokenize } = await import('../src/lexer.js');
  const { parse } = await import('../src/parser.js');
  const { compile } = await import('../src/compiler.js');
  const { run } = await import('../src/vm.js');
  const source = readFileSync(path.join(d, 'main.pen'), 'utf8');
  const r = run(compile(parse(tokenize(source))));
  expect(r.status).toBe('halted');
  rmSync(d, { recursive: true });
});
