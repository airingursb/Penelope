// Smoke checks for the docs site — well-formed HTML structure + cross-links resolve.

import { test, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

const SITE = 'docs-site';
const PAGES = ['index.html', 'tour.html', 'stdlib.html', 'cli.html', 'snapshot.html'];

test('all expected pages exist + share style.css', () => {
  for (const p of PAGES) expect(existsSync(path.join(SITE, p))).toBe(true);
  expect(existsSync(path.join(SITE, 'style.css'))).toBe(true);
});

test('every page links every other page in nav', () => {
  for (const p of PAGES) {
    const html = readFileSync(path.join(SITE, p), 'utf8');
    for (const other of PAGES) {
      expect(html).toContain(`href="${other}"`);
    }
  }
});

test('every page references stylesheet', () => {
  for (const p of PAGES) {
    const html = readFileSync(path.join(SITE, p), 'utf8');
    expect(html).toMatch(/<link[^>]+stylesheet[^>]+style\.css/);
  }
});

test('all internal links point at existing files', () => {
  for (const p of PAGES) {
    const html = readFileSync(path.join(SITE, p), 'utf8');
    const matches = html.matchAll(/href="([^"]+)"/g);
    for (const m of matches) {
      const target = m[1];
      // skip external + anchors
      if (target.startsWith('http') || target.startsWith('#') || target.startsWith('mailto:')) continue;
      const targetPath = path.join(SITE, target.split('#')[0]);
      expect(existsSync(targetPath), `${p} links to missing ${target}`).toBe(true);
    }
  }
});

test('GitHub Action workflow exists', () => {
  expect(existsSync('.github/workflows/deploy-docs.yml')).toBe(true);
});

test('site contains the core thesis sentence', () => {
  const idx = readFileSync(path.join(SITE, 'index.html'), 'utf8');
  expect(idx).toContain('pause/resume');
  expect(idx).toContain('language primitive');
});
