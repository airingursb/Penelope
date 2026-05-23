import type { Value } from './ast.js';

export type ConstantPoolEntry =
  | { tag: 'int';  v: number }
  | { tag: 'bool'; v: boolean }
  | { tag: 'str';  v: string }
  | { tag: 'unit' };

export type Opcode =
  | ['LOAD_CONST',    constIdx: number]
  | ['LOAD_VAR',      name: string, ic?: LoadVarIC | null]
  | ['STORE_VAR',     name: string]
  | ['BIN_OP',        op: string]
  | ['JUMP',          targetIp: number]
  | ['JUMP_IF_FALSE', targetIp: number]
  | ['MAKE_CLOSURE',  paramNames: string[], bodyIp: number, bodyLen: number]
  | ['CALL',          argc: number]
  | ['CALL_BUILTIN',  name: string, argc: number]
  | ['RETURN']
  | ['EFFECT',        name: string, argc: number, ic?: number | null]
  | ['PAUSE']
  | ['POP']
  | ['PUSH_UNIT']
  | ['ENTER_BLOCK']
  | ['EXIT_BLOCK']
  | ['HALT'];

export type LoadVarIC = { framesUp: number };

export type Program = {
  version: 1;
  source?: string;
  sourceHash?: string;
  constants: ConstantPoolEntry[];
  code: Opcode[];
};

export const OPCODE_NAMES: ReadonlySet<string> = new Set([
  'LOAD_CONST', 'LOAD_VAR', 'STORE_VAR', 'BIN_OP',
  'JUMP', 'JUMP_IF_FALSE',
  'MAKE_CLOSURE', 'CALL', 'CALL_BUILTIN', 'RETURN',
  'EFFECT', 'PAUSE',
  'POP', 'PUSH_UNIT',
  'ENTER_BLOCK', 'EXIT_BLOCK',
  'HALT',
]);

export function makeProgram(): Program {
  return { version: 1, constants: [], code: [] };
}

export function internConstant(pool: ConstantPoolEntry[], entry: ConstantPoolEntry): number {
  for (let i = 0; i < pool.length; i++) {
    const e = pool[i];
    if (e.tag !== entry.tag) continue;
    if (e.tag === 'unit' && entry.tag === 'unit') return i;
    if (e.tag === 'int' && entry.tag === 'int' && e.v === entry.v) return i;
    if (e.tag === 'bool' && entry.tag === 'bool' && e.v === entry.v) return i;
    if (e.tag === 'str' && entry.tag === 'str' && e.v === entry.v) return i;
  }
  pool.push(entry);
  return pool.length - 1;
}

export function valueToConstant(v: Value): ConstantPoolEntry {
  if (v.tag === 'int')  return { tag: 'int',  v: v.v };
  if (v.tag === 'bool') return { tag: 'bool', v: v.v };
  if (v.tag === 'str')  return { tag: 'str',  v: v.v };
  if (v.tag === 'unit') return { tag: 'unit' };
  throw new Error('cannot intern closure as constant');
}

export function constantToValue(e: ConstantPoolEntry): Value {
  if (e.tag === 'int')  return { tag: 'int',  v: e.v };
  if (e.tag === 'bool') return { tag: 'bool', v: e.v };
  if (e.tag === 'str')  return { tag: 'str',  v: e.v };
  return { tag: 'unit' };
}
