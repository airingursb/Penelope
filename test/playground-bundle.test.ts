// Smoke-test the playground bundle script.
// Runs build-playground.mjs and verifies the expected files land in docs-site/dist/.

import { test, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

beforeAll(() => {
  // dist/ must exist (npm run build already runs in CI / locally before tests)
  if (!existsSync('dist')) {
    spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
  }
  // Always clean + rebuild the bundle for a fresh test
  rmSync('docs-site/dist', { recursive: true, force: true });
  const r = spawnSync('node', ['scripts/build-playground.mjs'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
});

test('build-playground.mjs copies all required modules', () => {
  const must = [
    'docs-site/dist/lexer.js',
    'docs-site/dist/parser.js',
    'docs-site/dist/compiler.js',
    'docs-site/dist/vm.js',
    'docs-site/dist/optimizer.js',
    'docs-site/dist/typecheck.js',
    'docs-site/dist/diagnostic.js',
    'docs-site/dist/effects.js',
    'docs-site/dist/bytecode.js',
  ];
  for (const p of must) {
    expect(existsSync(p), `missing ${p}`).toBe(true);
  }
});

test('bundled effects.js is the browser shim (no node:fs imports)', () => {
  const text = readFileSync('docs-site/dist/effects.js', 'utf8');
  expect(text).not.toContain("from 'node:");
  expect(text).not.toContain('child_process');
  expect(text).toContain('EFFECT_NAMES');
});

test('bundled vm.js has no source-map comment (was stripped)', () => {
  const text = readFileSync('docs-site/dist/vm.js', 'utf8');
  expect(text).not.toContain('sourceMappingURL');
});

test('bundled optimizer passes are all present', () => {
  for (const p of ['constfold', 'dce', 'ic', 'inline', 'peephole']) {
    expect(existsSync(`docs-site/dist/optimizer/${p}.js`)).toBe(true);
  }
});

test('play.html references all expected imports', () => {
  const text = readFileSync('docs-site/play.html', 'utf8');
  expect(text).toContain("from './dist/lexer.js'");
  expect(text).toContain("from './dist/compiler.js'");
  expect(text).toContain("from './dist/vm.js'");
  expect(text).toContain("from './dist/optimizer.js'");
});
