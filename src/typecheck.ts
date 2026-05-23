// Penelope static type checker.
// A pragmatic, flow-based checker (NOT full Hindley-Milner). Validates:
//   - BinOp operand types (int+int, str+str for `+`; comparison int+int; equality any+same)
//   - If condition is bool
//   - Call: callee is fn; arity matches; arg types match params
//   - Var: defined in scope
//   - Let: binds inferred type
//
// Effect calls (print, now, etc) and builtins (list_*, dict_*, str_*) get hard-coded signatures.
// Closure parameter types start as 'unknown' and stay there unless inferred from default.
// Reports errors with line:col when AST nodes have positions.

import type { ASTNode, ASTBundle, BinOp, Pos } from './ast.js';

export type Type =
  | { kind: 'int' }
  | { kind: 'bool' }
  | { kind: 'str' }
  | { kind: 'unit' }
  | { kind: 'list' }
  | { kind: 'dict' }
  | { kind: 'fn'; params: Type[]; ret: Type }
  | { kind: 'unknown' };

export const T_INT: Type = { kind: 'int' };
export const T_BOOL: Type = { kind: 'bool' };
export const T_STR: Type = { kind: 'str' };
export const T_UNIT: Type = { kind: 'unit' };
export const T_LIST: Type = { kind: 'list' };
export const T_DICT: Type = { kind: 'dict' };
export const T_UNKNOWN: Type = { kind: 'unknown' };

export type TypeError = { message: string; pos?: Pos };

type Env = Map<string, Type>;

const BUILTIN_SIGS: Record<string, Type> = {
  // Effects
  print:       { kind: 'fn', params: [T_UNKNOWN], ret: T_UNIT },
  net_fetch:   { kind: 'fn', params: [T_STR], ret: T_STR },
  now:         { kind: 'fn', params: [], ret: T_INT },
  random_int:  { kind: 'fn', params: [T_INT, T_INT], ret: T_INT },
  read_file:   { kind: 'fn', params: [T_STR], ret: T_STR },
  write_file:  { kind: 'fn', params: [T_STR, T_STR], ret: T_UNIT },
  wait_until:  { kind: 'fn', params: [T_INT], ret: T_UNIT },
  wait_for:    { kind: 'fn', params: [T_STR], ret: T_UNKNOWN },
  // Pure builtins
  str_length:  { kind: 'fn', params: [T_STR], ret: T_INT },
  str_slice:   { kind: 'fn', params: [T_STR, T_INT, T_INT], ret: T_STR },
  to_str:      { kind: 'fn', params: [T_UNKNOWN], ret: T_STR },
  list_new:    { kind: 'fn', params: [], ret: T_LIST },   // varargs handled below
  list_push:   { kind: 'fn', params: [T_LIST, T_UNKNOWN], ret: T_LIST },
  list_get:    { kind: 'fn', params: [T_LIST, T_INT], ret: T_UNKNOWN },
  list_set:    { kind: 'fn', params: [T_LIST, T_INT, T_UNKNOWN], ret: T_LIST },
  list_len:    { kind: 'fn', params: [T_LIST], ret: T_INT },
  dict_new:    { kind: 'fn', params: [], ret: T_DICT },
  dict_set:    { kind: 'fn', params: [T_DICT, T_STR, T_UNKNOWN], ret: T_DICT },
  dict_get:    { kind: 'fn', params: [T_DICT, T_STR], ret: T_UNKNOWN },
  dict_has:    { kind: 'fn', params: [T_DICT, T_STR], ret: T_BOOL },
  dict_keys:   { kind: 'fn', params: [T_DICT], ret: T_LIST },
};

const VARARG_BUILTINS = new Set(['list_new']);

export function check(ast: ASTBundle): TypeError[] {
  const errors: TypeError[] = [];
  const env: Env = new Map();
  const nodeTypes = new Map<string, Type>();
  checkNode(ast.nodes[ast.rootId], ast, env, errors, nodeTypes);
  return errors;
}

// Like check, but also returns the inferred type for each AST node (by id).
export function checkWithTypes(ast: ASTBundle): { errors: TypeError[]; types: Map<string, Type> } {
  const errors: TypeError[] = [];
  const env: Env = new Map();
  const types = new Map<string, Type>();
  checkNode(ast.nodes[ast.rootId], ast, env, errors, types);
  return { errors, types };
}

function checkNode(node: ASTNode, ast: ASTBundle, env: Env, errors: TypeError[], nodeTypes?: Map<string, Type>): Type {
  const t = dispatchNode(node, ast, env, errors, nodeTypes);
  if (nodeTypes) nodeTypes.set(node.id, t);
  return t;
}

function dispatchNode(node: ASTNode, ast: ASTBundle, env: Env, errors: TypeError[], nodeTypes?: Map<string, Type>): Type {
  switch (node.kind) {
    case 'Program': {
      for (const id of node.stmtIds) checkNode(ast.nodes[id], ast, env, errors, nodeTypes);
      return T_UNIT;
    }
    case 'IntLit':    return T_INT;
    case 'BoolLit':   return T_BOOL;
    case 'StringLit': return T_STR;
    case 'Pause':     return T_UNIT;
    case 'Var': {
      const t = env.get(node.name);
      if (!t) {
        errors.push({ message: `undefined variable '${node.name}'`, pos: node.pos });
        return T_UNKNOWN;
      }
      return t;
    }
    case 'ExprStmt': {
      checkNode(ast.nodes[node.exprId], ast, env, errors, nodeTypes);
      return T_UNIT;
    }
    case 'Let': {
      const vt = checkNode(ast.nodes[node.valueId], ast, env, errors, nodeTypes);
      env.set(node.name, vt);
      return T_UNIT;
    }
    case 'BinOp':    return checkBinOp(node, ast, env, errors, nodeTypes);
    case 'If':       return checkIf(node, ast, env, errors, nodeTypes);
    case 'Block':    return checkBlock(node, ast, env, errors, nodeTypes);
    case 'Fn':       return checkFn(node, ast, env, errors, nodeTypes);
    case 'Call':     return checkCall(node, ast, env, errors, nodeTypes);
    default: {
      const n = node as ASTNode;
      errors.push({ message: `typecheck: unhandled node kind '${n.kind}'`, pos: n.pos });
      return T_UNKNOWN;
    }
  }
}

function checkBinOp(node: Extract<ASTNode, { kind: 'BinOp' }>, ast: ASTBundle, env: Env, errors: TypeError[], nodeTypes?: Map<string, Type>): Type {
  const left = checkNode(ast.nodes[node.leftId], ast, env, errors, nodeTypes);
  const right = checkNode(ast.nodes[node.rightId], ast, env, errors, nodeTypes);
  const op = node.op as BinOp;
  if (op === '+') {
    if (matches(left, T_INT) && matches(right, T_INT)) return T_INT;
    if (matches(left, T_STR) && matches(right, T_STR)) return T_STR;
    if (left.kind !== 'unknown' && right.kind !== 'unknown') {
      errors.push({ message: `binop '+' requires int+int or str+str, got ${typeStr(left)}+${typeStr(right)}`, pos: node.pos });
    }
    return T_UNKNOWN;
  }
  if (op === '-' || op === '*' || op === '/') {
    if (!matches(left, T_INT) || !matches(right, T_INT)) {
      if (left.kind !== 'unknown' && right.kind !== 'unknown') {
        errors.push({ message: `binop '${op}' requires int, got ${typeStr(left)}+${typeStr(right)}`, pos: node.pos });
      }
    }
    return T_INT;
  }
  if (op === '<' || op === '>' || op === '<=' || op === '>=') {
    if (!matches(left, T_INT) || !matches(right, T_INT)) {
      if (left.kind !== 'unknown' && right.kind !== 'unknown') {
        errors.push({ message: `binop '${op}' requires int, got ${typeStr(left)}+${typeStr(right)}`, pos: node.pos });
      }
    }
    return T_BOOL;
  }
  if (op === '==' || op === '!=') {
    // Equality: types must match (or one is unknown)
    if (left.kind !== 'unknown' && right.kind !== 'unknown' && left.kind !== right.kind) {
      errors.push({ message: `binop '${op}' type mismatch: ${typeStr(left)} vs ${typeStr(right)}`, pos: node.pos });
    }
    return T_BOOL;
  }
  return T_UNKNOWN;
}

function checkIf(node: Extract<ASTNode, { kind: 'If' }>, ast: ASTBundle, env: Env, errors: TypeError[], nodeTypes?: Map<string, Type>): Type {
  const cond = checkNode(ast.nodes[node.condId], ast, env, errors, nodeTypes);
  if (!matches(cond, T_BOOL) && cond.kind !== 'unknown') {
    errors.push({ message: `if condition must be bool, got ${typeStr(cond)}`, pos: ast.nodes[node.condId].pos });
  }
  const t = checkNode(ast.nodes[node.thenBlockId], ast, env, errors, nodeTypes);
  const e = checkNode(ast.nodes[node.elseBlockId], ast, env, errors, nodeTypes);
  if (t.kind !== e.kind && t.kind !== 'unknown' && e.kind !== 'unknown') {
    return T_UNKNOWN;
  }
  return t.kind !== 'unknown' ? t : e;
}

function checkBlock(node: Extract<ASTNode, { kind: 'Block' }>, ast: ASTBundle, env: Env, errors: TypeError[], nodeTypes?: Map<string, Type>): Type {
  const local = new Map(env);
  for (const id of node.stmtIds) checkNode(ast.nodes[id], ast, local, errors, nodeTypes);
  if (node.trailingExprId !== null) return checkNode(ast.nodes[node.trailingExprId], ast, local, errors, nodeTypes);
  return T_UNIT;
}

function checkFn(node: Extract<ASTNode, { kind: 'Fn' }>, ast: ASTBundle, env: Env, errors: TypeError[], nodeTypes?: Map<string, Type>): Type {
  const body = ast.nodes[node.bodyBlockId];
  const local = new Map(env);
  const paramTypes: Type[] = [];
  for (const p of node.params) {
    local.set(p, T_UNKNOWN);
    paramTypes.push(T_UNKNOWN);
  }
  const ret = checkNode(body, ast, local, errors, nodeTypes);
  return { kind: 'fn', params: paramTypes, ret };
}

function checkCall(node: Extract<ASTNode, { kind: 'Call' }>, ast: ASTBundle, env: Env, errors: TypeError[], nodeTypes?: Map<string, Type>): Type {
  const callee = ast.nodes[node.calleeId];
  // Special-case for known-name calls (effects/builtins) to use BUILTIN_SIGS.
  if (callee.kind === 'Var' && callee.name in BUILTIN_SIGS) {
    const sig = BUILTIN_SIGS[callee.name];
    if (sig.kind !== 'fn') return T_UNKNOWN;
    if (!VARARG_BUILTINS.has(callee.name) && node.argIds.length !== sig.params.length) {
      errors.push({
        message: `${callee.name}: expected ${sig.params.length} args, got ${node.argIds.length}`,
        pos: node.pos,
      });
    }
    for (let i = 0; i < node.argIds.length; i++) {
      const at = checkNode(ast.nodes[node.argIds[i]], ast, env, errors, nodeTypes);
      const exp = sig.params[i] ?? T_UNKNOWN;
      if (!matches(at, exp) && at.kind !== 'unknown' && exp.kind !== 'unknown') {
        errors.push({
          message: `${callee.name}: arg ${i + 1} expected ${typeStr(exp)}, got ${typeStr(at)}`,
          pos: ast.nodes[node.argIds[i]].pos,
        });
      }
    }
    return sig.ret;
  }
  const calleeType = checkNode(callee, ast, env, errors, nodeTypes);
  if (calleeType.kind === 'unknown') {
    for (const id of node.argIds) checkNode(ast.nodes[id], ast, env, errors, nodeTypes);
    return T_UNKNOWN;
  }
  if (calleeType.kind !== 'fn') {
    errors.push({ message: `call: callee is ${typeStr(calleeType)}, not a function`, pos: node.pos });
    return T_UNKNOWN;
  }
  if (calleeType.params.length !== node.argIds.length) {
    errors.push({
      message: `call: arity mismatch — expected ${calleeType.params.length}, got ${node.argIds.length}`,
      pos: node.pos,
    });
  }
  for (let i = 0; i < node.argIds.length; i++) {
    checkNode(ast.nodes[node.argIds[i]], ast, env, errors, nodeTypes);
  }
  return calleeType.ret;
}

function matches(a: Type, b: Type): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown') return true;
  return a.kind === b.kind;
}

export function typeStr(t: Type): string {
  if (t.kind === 'fn') return `fn(${t.params.map(typeStr).join(', ')}) -> ${typeStr(t.ret)}`;
  return t.kind;
}

export function formatErrors(errors: TypeError[]): string {
  return errors.map(e => {
    const at = e.pos ? ` at line ${e.pos.line} col ${e.pos.col}` : '';
    return `type error: ${e.message}${at}`;
  }).join('\n');
}
