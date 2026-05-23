import { test, expect } from 'vitest';
import { loadSourceWithMap } from '../src/loader.js';
import { diagnosticFromMessage, formatDiagnostic } from '../src/diagnostic.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeMod(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-map-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('loadSourceWithMap produces a lineMap with one entry per concatenated line', () => {
  const dir = makeMod({
    'lib.pen': 'let helper = 1;\nlet other = 2;\n',
    'main.pen': 'import "./lib.pen";\nlet x = helper;\n',
  });
  const { source, lineMap } = loadSourceWithMap(path.join(dir, 'main.pen'));
  // lineMap entries should be at least source.split('\n').length
  expect(lineMap.length).toBeGreaterThanOrEqual(source.split('\n').length - 1);
  // The first two lines should originate from lib.pen.
  expect(lineMap[0].file).toContain('lib.pen');
  expect(lineMap[0].line).toBe(1);
  expect(lineMap[1].file).toContain('lib.pen');
  expect(lineMap[1].line).toBe(2);
  rmSync(dir, { recursive: true });
});

test('diagnosticFromMessage translates concat line back to original file:line', () => {
  const lineMap = [
    { file: 'lib.pen', line: 1 },
    { file: 'lib.pen', line: 2 },
    { file: 'main.pen', line: 2 },
  ];
  const d = diagnosticFromMessage(
    `undefined variable 'foo' at line 2 col 3`,
    undefined,
    'main.pen',
    lineMap,
  );
  expect(d.pos?.line).toBe(2);
  expect(d.filename).toBe('lib.pen');
});

test('full pipeline: error in imported file points to that file', () => {
  const lineMap = [
    { file: 'lib.pen', line: 1 },
    { file: 'lib.pen', line: 5 },
    { file: 'main.pen', line: 2 },
  ];
  const out = formatDiagnostic(diagnosticFromMessage(
    `undefined variable 'x' at line 2 col 1`,
    'let helper = 1;\nlet other = bad;\nlet x = helper;',
    'main.pen',
    lineMap,
  ));
  expect(out).toContain('lib.pen:5:1');
});

test('no lineMap → original filename preserved', () => {
  const d = diagnosticFromMessage(
    `oops at line 3 col 4`,
    undefined,
    'foo.pen',
  );
  expect(d.filename).toBe('foo.pen');
  expect(d.pos?.line).toBe(3);
});
