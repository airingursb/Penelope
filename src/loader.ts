// Module loader — recursively expands `import "./path.pen";` statements
// into a single source string before tokenization. Path resolution is
// relative to the importing file. Loaded files are deduplicated by their
// absolute path (idempotent re-imports; cycle-safe).
//
// Also produces a per-line map from concatenated-source line → original
// (file, line). Diagnostics use this to point at the right place.

import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';

const IMPORT_REGEX = /^\s*import\s+"([^"]+)"\s*;\s*$/gm;

export type LineOrigin = { file: string; line: number };

export type LoaderOpts = {
  read?: (absPath: string) => string;
  resolve?: (importPath: string, fromDir: string) => string;
  /** If set, file paths in the LineOrigin map are relative to this dir for prettier display. */
  cwd?: string;
};

// Back-compat: returns just the concatenated source.
export function loadSource(rootPath: string, opts: LoaderOpts = {}): string {
  return loadSourceWithMap(rootPath, opts).source;
}

// Returns the concatenated source AND a per-line origin map so diagnostics
// can report the original file:line for any position in the concatenated source.
export function loadSourceWithMap(rootPath: string, opts: LoaderOpts = {}): {
  source: string;
  lineMap: LineOrigin[];   // 0-indexed: lineMap[concatLine - 1] = origin
} {
  const read = opts.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const resolveFn = opts.resolve ?? ((p: string, fromDir: string) => resolve(fromDir, p));
  const cwd = opts.cwd ?? process.cwd();
  const seen = new Set<string>();
  const lineMap: LineOrigin[] = [];
  const source = expand(resolve(rootPath), seen, read, resolveFn, cwd, lineMap);
  return { source, lineMap };
}

function expand(
  absPath: string,
  seen: Set<string>,
  read: (p: string) => string,
  resolveFn: (p: string, fromDir: string) => string,
  cwd: string,
  lineMap: LineOrigin[],
): string {
  if (seen.has(absPath)) return '';
  seen.add(absPath);

  const source = read(absPath);
  const fromDir = dirname(absPath);
  const fileLabel = relative(cwd, absPath) || absPath;

  // Track current line in the original file as we walk through it.
  const fragments: string[] = [];
  let origLine = 1;
  let lastEnd = 0;
  const matches = [...source.matchAll(IMPORT_REGEX)];
  for (const m of matches) {
    // Append source text up to this import.
    const chunk = source.slice(lastEnd, m.index!);
    fragments.push(chunk);
    // Record line origins for each newline-terminated line in this chunk.
    const chunkLines = chunk.split('\n');
    for (let i = 0; i < chunkLines.length - 1; i++) {
      lineMap.push({ file: fileLabel, line: origLine });
      origLine++;
    }
    // Last partial line carries over — handled when next chunk lands or via final flush.
    // Recurse into the import; the imported file's lineMap entries get appended in-place.
    const importPath = m[1];
    const importAbs = resolveFn(importPath, fromDir);
    fragments.push(expand(importAbs, seen, read, resolveFn, cwd, lineMap));
    // The import statement itself was on one line — advance origLine by its newline count + 1.
    const importLineCount = m[0].split('\n').length;
    origLine += importLineCount;
    lastEnd = m.index! + m[0].length;
  }
  // Final fragment after the last import.
  const tail = source.slice(lastEnd);
  fragments.push(tail);
  const tailLines = tail.split('\n');
  for (let i = 0; i < tailLines.length; i++) {
    lineMap.push({ file: fileLabel, line: origLine });
    origLine++;
  }

  return fragments.join('');
}
