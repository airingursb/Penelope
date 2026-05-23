import { test, expect } from 'vitest';
import { loadSource } from '../src/loader.js';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeMod(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pen-mod-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('loadSource on a file with no imports returns the file contents', () => {
  const dir = makeMod({ 'a.pen': 'let x = 1;' });
  const out = loadSource(path.join(dir, 'a.pen'));
  expect(out).toBe('let x = 1;');
  rmSync(dir, { recursive: true });
});

test('loadSource expands a single import', () => {
  const dir = makeMod({
    'lib.pen': 'let helper = 42;',
    'main.pen': 'import "./lib.pen";\nlet x = helper;',
  });
  const out = loadSource(path.join(dir, 'main.pen'));
  expect(out).toContain('let helper = 42;');
  expect(out).toContain('let x = helper;');
  expect(out).not.toContain('import');
  rmSync(dir, { recursive: true });
});

test('loadSource is idempotent — re-importing the same file is a no-op', () => {
  const dir = makeMod({
    'shared.pen': 'let only_once = 1;',
    'a.pen': 'import "./shared.pen";\nlet a = 1;',
    'main.pen': 'import "./shared.pen";\nimport "./a.pen";\nlet m = 1;',
  });
  const out = loadSource(path.join(dir, 'main.pen'));
  // shared.pen body should only appear once.
  const occurrences = out.split('let only_once = 1;').length - 1;
  expect(occurrences).toBe(1);
  rmSync(dir, { recursive: true });
});

test('loadSource handles cyclic imports without infinite loop', () => {
  const dir = makeMod({
    'a.pen': 'import "./b.pen";\nlet a = 1;',
    'b.pen': 'import "./a.pen";\nlet b = 2;',
  });
  const out = loadSource(path.join(dir, 'a.pen'));
  expect(out).toContain('let a = 1;');
  expect(out).toContain('let b = 2;');
  rmSync(dir, { recursive: true });
});

test('imported lets are accessible in importing file at runtime', () => {
  const dir = makeMod({
    'util.pen': 'let double = fn(x) { x * 2 };',
    'main.pen': 'import "./util.pen";\nlet result = double(21);',
  });
  const source = loadSource(path.join(dir, 'main.pen'));
  const r = run(compile(parse(tokenize(source))));
  expect(r.state.frames[0].bindings.result).toEqual({ tag: 'int', v: 42 });
  rmSync(dir, { recursive: true });
});

test('transitive imports work (a imports b, b imports c)', () => {
  const dir = makeMod({
    'c.pen': 'let three = 3;',
    'b.pen': 'import "./c.pen";\nlet two = 2;',
    'a.pen': 'import "./b.pen";\nlet sum = three + two;',
  });
  const source = loadSource(path.join(dir, 'a.pen'));
  const r = run(compile(parse(tokenize(source))));
  expect(r.state.frames[0].bindings.sum).toEqual({ tag: 'int', v: 5 });
  rmSync(dir, { recursive: true });
});

test('loadSource accepts injected reader (in-memory testing)', () => {
  const files: Record<string, string> = {
    '/virtual/lib.pen': 'let x = 100;',
    '/virtual/main.pen': 'import "./lib.pen";\nlet y = x + 1;',
  };
  const out = loadSource('/virtual/main.pen', {
    read: (p) => {
      if (files[p]) return files[p];
      throw new Error(`not found: ${p}`);
    },
  });
  expect(out).toContain('let x = 100;');
  expect(out).toContain('let y = x + 1;');
});

test('import statement with trailing semicolon and whitespace is recognized', () => {
  const dir = makeMod({
    'l.pen': 'let q = 7;',
    'main.pen': '   import "./l.pen"  ;   \nlet m = q;',
  });
  const out = loadSource(path.join(dir, 'main.pen'));
  expect(out).toContain('let q = 7;');
  rmSync(dir, { recursive: true });
});
