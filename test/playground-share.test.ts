// Verify the play.html structure has the share button + initial loading logic.
// This is a documentation/smoke test — actual browser behavior isn't tested.

import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync('docs-site/play.html', 'utf8');

test('share button exists', () => {
  expect(html).toContain('id="share"');
  expect(html).toContain('🔗 Share');
});

test('loadInitial handles #code= URL fragment', () => {
  expect(html).toContain("hash.get('code')");
  expect(html).toContain('atob(');
});

test('loadInitial handles ?example= query param', () => {
  expect(html).toContain("params.get('example')");
});

test('buildShareUrl encodes with URL-safe base64', () => {
  expect(html).toContain("btoa(text)");
  expect(html).toContain(".replace(/\\+/g, '-')");
  expect(html).toContain(".replace(/\\//g, '_')");
});

test('share button copies to clipboard with fallback', () => {
  expect(html).toContain('navigator.clipboard.writeText');
});
