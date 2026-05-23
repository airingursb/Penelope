import { test, expect } from 'vitest';
import { serializeProgram, deserializeProgram, writePencFile, readPencFile } from '../src/encoder.js';
import type { Program } from '../src/bytecode.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('Program with primitive constants roundtrips byte-for-byte', () => {
  const prog: Program = {
    version: 1,
    sourceHash: 'sha256:abc',
    constants: [{ tag: 'int', v: 42 }, { tag: 'str', v: 'hi' }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['HALT']],
  };
  const json = serializeProgram(prog);
  const parsed = deserializeProgram(json);
  if ('error' in parsed) throw new Error(parsed.error);
  expect(parsed.prog).toEqual(prog);
});

test('deserialize rejects wrong version', () => {
  const r = deserializeProgram(JSON.stringify({ version: 99, constants: [], code: [] }));
  expect('error' in r).toBe(true);
});

test('deserialize rejects unknown opcode', () => {
  const json = JSON.stringify({ version: 1, constants: [], code: [['BOGUS']] });
  const r = deserializeProgram(json);
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/unknown opcode 'BOGUS'/);
});

test('deserialize rejects malformed JSON', () => {
  expect('error' in deserializeProgram('{ not json')).toBe(true);
});

test('serialize is deterministic (stable key order)', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['LOAD_CONST', 0], ['HALT']],
  };
  const a = serializeProgram(prog);
  const b = serializeProgram(prog);
  expect(a).toBe(b);
});

test('writePencFile + readPencFile roundtrips', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 7 }],
    code: [['LOAD_CONST', 0], ['HALT']],
  };
  const tmp = path.join(os.tmpdir(), `pen-test-${Date.now()}.penc`);
  writePencFile(tmp, prog);
  const r = readPencFile(tmp);
  if ('error' in r) throw new Error(r.error);
  expect(r.prog).toEqual(prog);
  fs.unlinkSync(tmp);
});

test('readPencFile on missing file returns error', () => {
  const r = readPencFile('/tmp/does-not-exist-' + Date.now() + '.penc');
  expect('error' in r).toBe(true);
});
