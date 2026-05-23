// Penelope bytecode encoder (.penc files).
// Produces deterministic JSON; rejects unknown versions/opcodes on read.

import type { Program } from './bytecode.js';
import { OPCODE_NAMES } from './bytecode.js';

export function serializeProgram(prog: Program): string {
  return JSON.stringify(prog, null, 2);
}

export type DeserializeResult =
  | { prog: Program }
  | { error: string };

export function deserializeProgram(text: string): DeserializeResult {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (e) { return { error: `invalid JSON: ${(e as Error).message}` }; }
  if (typeof parsed !== 'object' || parsed === null) return { error: 'not an object' };
  const p = parsed as any;
  if (p.version !== 1) return { error: `unknown program version: ${p.version}` };
  if (!Array.isArray(p.constants)) return { error: 'constants must be array' };
  if (!Array.isArray(p.code))      return { error: 'code must be array' };
  for (let i = 0; i < p.code.length; i++) {
    const op = p.code[i];
    if (!Array.isArray(op) || typeof op[0] !== 'string') {
      return { error: `code[${i}]: not an opcode tuple` };
    }
    if (!OPCODE_NAMES.has(op[0])) {
      return { error: `code[${i}]: unknown opcode '${op[0]}'` };
    }
  }
  return { prog: p as Program };
}

import * as fs from 'fs';

export function writePencFile(filePath: string, prog: Program): void {
  fs.writeFileSync(filePath, serializeProgram(prog), 'utf8');
}

export function readPencFile(filePath: string): DeserializeResult {
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { return { error: `cannot read ${filePath}: ${(e as Error).message}` }; }
  return deserializeProgram(text);
}
