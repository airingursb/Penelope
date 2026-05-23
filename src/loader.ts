// Module loader — recursively expands `import "./path.pen";` statements
// into a single source string before tokenization. Path resolution is
// relative to the importing file. Loaded files are deduplicated by their
// absolute path (idempotent re-imports; cycle-safe).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const IMPORT_REGEX = /^\s*import\s+"([^"]+)"\s*;\s*$/gm;

export type LoaderOpts = {
  read?: (absPath: string) => string;
  resolve?: (importPath: string, fromDir: string) => string;
};

export function loadSource(rootPath: string, opts: LoaderOpts = {}): string {
  const read = opts.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const resolveFn = opts.resolve ?? ((p: string, fromDir: string) => resolve(fromDir, p));
  const seen = new Set<string>();
  return expand(resolve(rootPath), seen, read, resolveFn);
}

function expand(
  absPath: string,
  seen: Set<string>,
  read: (p: string) => string,
  resolveFn: (p: string, fromDir: string) => string,
): string {
  if (seen.has(absPath)) return '';   // cycle / re-import: no-op
  seen.add(absPath);

  const source = read(absPath);
  const fromDir = dirname(absPath);
  const fragments: string[] = [];

  // Find every `import "..."` and replace with the expanded source of that path.
  let lastEnd = 0;
  const matches = [...source.matchAll(IMPORT_REGEX)];
  for (const m of matches) {
    // Append the text between the last match and this one, with the import line removed.
    fragments.push(source.slice(lastEnd, m.index!));
    const importPath = m[1];
    const importAbs = resolveFn(importPath, fromDir);
    fragments.push(expand(importAbs, seen, read, resolveFn));
    lastEnd = m.index! + m[0].length;
  }
  fragments.push(source.slice(lastEnd));

  return fragments.join('');
}
