// Build the browser playground bundle by copying the compiled JS modules
// from dist/ to docs-site/dist/ and supplying a browser-safe effects shim.
//
// Run after `npm run build`. CI does this automatically (see .github/workflows/deploy-docs.yml).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SRC_DIR = 'dist';
const OUT_DIR = 'docs-site/dist';

if (!existsSync(SRC_DIR)) {
  console.error(`error: ${SRC_DIR}/ not found — run 'npm run build' first`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, 'optimizer'), { recursive: true });

const FILES_TO_COPY = [
  'ast.js',
  'lexer.js',
  'parser.js',
  'bytecode.js',
  'compiler.js',
  'snapshot.js',
  'vm.js',
  'optimizer.js',
  'typecheck.js',
  'diagnostic.js',
  ...readdirSync(join(SRC_DIR, 'optimizer'))
    .filter(f => f.endsWith('.js'))
    .map(f => `optimizer/${f}`),
];

for (const file of FILES_TO_COPY) {
  const srcPath = join(SRC_DIR, file);
  const outPath = join(OUT_DIR, file);
  mkdirSync(dirname(outPath), { recursive: true });
  let content = readFileSync(srcPath, 'utf8');
  // Strip source-map comments
  content = content.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  writeFileSync(outPath, content);
}

// Browser-safe effects shim. Replaces dist/effects.js for the playground.
// Network: uses fetch(); print: captures to a buffer the host can drain;
// file effects: throw (not supported in browser).
const browserEffects = `// Browser shim for src/effects.ts — used by the playground.

export const EFFECT_NAMES = new Set([
  'print', 'net_fetch', 'now', 'random_int',
  'read_file', 'write_file', 'wait_until', 'wait_for',
]);

const WAIT_EFFECTS = new Set(['wait_until', 'wait_for']);
const WRITE_EFFECTS = new Set(['print', 'write_file']);

export function categoryOf(name) {
  if (WAIT_EFFECTS.has(name)) return 'wait';
  if (WRITE_EFFECTS.has(name)) return 'write';
  return 'read';
}

// Playground captures prints here; UI drains after each run.
export const playgroundOutput = [];

export function performPrint(args) {
  // VM's EFFECT handler does its own console.log — we don't reach here in the
  // browser. (vm.ts calls console.log inline for 'print' rather than calling
  // performPrint.) We export this for completeness.
  const s = args.map(v => stringifyValue(v)).join(' ');
  playgroundOutput.push(s);
  return { tag: 'unit' };
}

export function performNetFetch(args) {
  throw new Error('net_fetch in playground requires async — not yet supported');
}

export function performNow(timeOverride) {
  return timeOverride != null ? timeOverride : Date.now();
}

export function performRandomInt(args) {
  const lo = args[0]?.v ?? 0;
  const hi = args[1]?.v ?? 1;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

export function performReadFile(args) {
  throw new Error('read_file is not available in the browser playground');
}

export function performWriteFile(args) {
  throw new Error('write_file is not available in the browser playground');
}

function stringifyValue(v) {
  if (!v) return '';
  if (v.tag === 'str') return v.v;
  if (v.tag === 'int') return String(v.v);
  if (v.tag === 'bool') return v.v ? 'true' : 'false';
  if (v.tag === 'unit') return '()';
  return JSON.stringify(v);
}
`;

writeFileSync(join(OUT_DIR, 'effects.js'), browserEffects);

console.log('✓ playground bundle written to ' + OUT_DIR + '/ (' + FILES_TO_COPY.length + ' files + browser effects shim)');
