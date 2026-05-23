import { test, expect } from 'vitest';
import { EFFECT_NAMES, categoryOf } from '../src/effects.js';
import { serialize, deserialize, sha256 } from '../src/snapshot.js';
import type { Snapshot } from '../src/snapshot.js';

test('EFFECT_NAMES contains all 8 effects', () => {
  expect(EFFECT_NAMES.size).toBe(8);
  for (const name of ['print', 'net_fetch', 'now', 'random_int', 'read_file', 'write_file', 'wait_until', 'wait_for']) {
    expect(EFFECT_NAMES.has(name as any)).toBe(true);
  }
});

test('categoryOf classifies effects correctly', () => {
  expect(categoryOf('print')).toBe('write');
  expect(categoryOf('write_file')).toBe('write');
  expect(categoryOf('net_fetch')).toBe('read');
  expect(categoryOf('now')).toBe('read');
  expect(categoryOf('random_int')).toBe('read');
  expect(categoryOf('read_file')).toBe('read');
  expect(categoryOf('wait_until')).toBe('wait');
  expect(categoryOf('wait_for')).toBe('wait');
});

test('B4: snapshot with effects[] survives serialize/deserialize roundtrip', () => {
  const source = 'let x = 1;';
  const snap: Snapshot = {
    version: 3,
    programPath: 'x.pen',
    programHash: 'sha256:' + sha256(source),
    pausedAtIP: 5,
    pausedAtMs: 12345,
    state: {
      ip: 5,
      valueStack: [],
      frames: [{ bindings: {} }],
      effects: [
        { ip: 2, invocationCount: 0, effect: 'print', recordedValue: null, status: 'committed' },
        { ip: 4, invocationCount: 0, effect: 'net_fetch', recordedValue: { tag: 'str', v: 'response body' }, status: 'committed' },
        { ip: 6, invocationCount: 0, effect: 'wait_for', recordedValue: { tag: 'str', v: 'approval' }, status: 'pending' },
      ],
    },
  };
  const r = deserialize(serialize(snap), () => source);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap).toEqual(snap);
});

test('H5: hash mismatch with --force preserves effects log on deserialize', () => {
  const source = 'let x = 1;';
  const snap: Snapshot = {
    version: 3,
    programPath: 'x.pen',
    programHash: 'sha256:' + sha256(source),
    pausedAtIP: 5,
    pausedAtMs: 0,
    state: {
      ip: 5,
      valueStack: [],
      frames: [{ bindings: {} }],
      effects: [
        { ip: 1, invocationCount: 0, effect: 'print', recordedValue: null, status: 'committed' },
      ],
    },
  };
  const r = deserialize(serialize(snap), () => 'let x = 2;', { force: true });
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap.state.effects).toHaveLength(1);
  expect(r.snap.state.effects[0].effect).toBe('print');
});

import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { runToCompletion } from '../src/legacy-interpreter.js';

test('reserved builtin name cannot be shadowed via let', () => {
  const ast = parse(tokenize('let net_fetch = 0;'));
  const r = runToCompletion(ast);
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.message).toMatch(/reserved/);
});

test('reserved pure builtin name cannot be shadowed via let', () => {
  const ast = parse(tokenize('let str_length = 0;'));
  const r = runToCompletion(ast);
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.message).toMatch(/reserved/);
});

import { initialState, step } from '../src/legacy-interpreter.js';

test('B1: print appends one effect entry', () => {
  const ast = parse(tokenize('print(1);'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    let s = initialState(ast.rootId);
    while (true) {
      const r = step(s, ast);
      if (r.kind === 'continue') { s = r.state; continue; }
      if (r.kind === 'done') break;
      throw new Error(`unexpected result: ${r.kind}`);
    }
    expect(logged).toEqual(['1']);
    expect(s.effects).toHaveLength(1);
    expect(s.effects[0].effect).toBe('print');
    expect(s.effects[0].invocationCount).toBe(0);
    expect(s.effects[0].status).toBe('committed');
  } finally { console.log = origLog; }
});

test('B2 + B3: two distinct print call sites get separate entries; invocationCount 0 each', () => {
  const ast = parse(tokenize('print(1); print(2);'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    let s = initialState(ast.rootId);
    while (true) {
      const r = step(s, ast);
      if (r.kind === 'continue') { s = r.state; continue; }
      if (r.kind === 'done') break;
      throw new Error(`unexpected: ${r.kind}`);
    }
    expect(logged).toEqual(['1', '2']);
    expect(s.effects).toHaveLength(2);
    expect(s.effects[0].nodeId).not.toBe(s.effects[1].nodeId);
    expect(s.effects[0].invocationCount).toBe(0);
    expect(s.effects[1].invocationCount).toBe(0);
  } finally { console.log = origLog; }
});
