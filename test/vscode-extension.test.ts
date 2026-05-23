// Validate the VSCode extension manifest + grammar are well-formed,
// without actually loading VSCode.

import { test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = 'vscode-extension';

test('package.json is valid JSON and declares the penelope language', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'));
  expect(pkg.name).toBe('penelope-vscode');
  expect(pkg.contributes.languages[0].id).toBe('penelope');
  expect(pkg.contributes.languages[0].extensions).toContain('.pen');
});

test('tmLanguage grammar is valid JSON with correct scope', () => {
  const tm = JSON.parse(readFileSync(`${ROOT}/syntaxes/penelope.tmLanguage.json`, 'utf8'));
  expect(tm.scopeName).toBe('source.penelope');
  expect(tm.fileTypes).toContain('pen');
});

test('grammar matches all Penelope keywords', () => {
  const tm = JSON.parse(readFileSync(`${ROOT}/syntaxes/penelope.tmLanguage.json`, 'utf8'));
  const kw = tm.repository.keyword.match;
  for (const word of ['let', 'fn', 'if', 'else', 'true', 'false', 'pause']) {
    expect(kw).toContain(word);
  }
});

test('grammar matches all builtins including list/dict', () => {
  const tm = JSON.parse(readFileSync(`${ROOT}/syntaxes/penelope.tmLanguage.json`, 'utf8'));
  const bi = tm.repository.builtin.match;
  for (const fn of ['print', 'now', 'wait_for', 'str_length', 'list_new', 'list_push', 'dict_new', 'dict_get']) {
    expect(bi).toContain(fn);
  }
});

test('language-configuration.json defines line comment + brackets', () => {
  const cfg = JSON.parse(readFileSync(`${ROOT}/language-configuration.json`, 'utf8'));
  expect(cfg.comments.lineComment).toBe('//');
  expect(cfg.brackets).toContainEqual(['{', '}']);
});

test('extension.js exists', () => {
  expect(existsSync(`${ROOT}/extension.js`)).toBe(true);
});

test('README + .vscodeignore present', () => {
  expect(existsSync(`${ROOT}/README.md`)).toBe(true);
  expect(existsSync(`${ROOT}/.vscodeignore`)).toBe(true);
});
