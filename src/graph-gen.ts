// pen graph: walk imports from a root .pen file and emit the dependency graph as DOT.

import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';

const IMPORT_REGEX = /^\s*import\s+"([^"]+)"\s*;\s*$/gm;

export type GraphEdge = { from: string; to: string };

export function buildGraph(rootPath: string, cwd: string = process.cwd()): GraphEdge[] {
  const abs = resolve(rootPath);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  walk(abs, edges, seen, cwd);
  return edges;
}

function walk(absPath: string, edges: GraphEdge[], seen: Set<string>, cwd: string): void {
  if (seen.has(absPath)) return;
  seen.add(absPath);
  const label = relative(cwd, absPath) || absPath;
  let source: string;
  try { source = readFileSync(absPath, 'utf8'); }
  catch { return; }
  const fromDir = dirname(absPath);
  for (const m of source.matchAll(IMPORT_REGEX)) {
    const targetAbs = resolve(fromDir, m[1]);
    const targetLabel = relative(cwd, targetAbs) || targetAbs;
    edges.push({ from: label, to: targetLabel });
    walk(targetAbs, edges, seen, cwd);
  }
}

export function renderDot(rootPath: string, edges: GraphEdge[]): string {
  const lines: string[] = [];
  lines.push('digraph Penelope {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, fontname="Menlo,monospace", fontsize=11, style=filled, fillcolor="#f0eef5"];');
  lines.push(`  "${rootPath}" [fillcolor="#c792ea", fontcolor="#fff"];`);
  const seen = new Set<string>();
  for (const e of edges) {
    const key = `${e.from} -> ${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  "${e.from}" -> "${e.to}";`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}
