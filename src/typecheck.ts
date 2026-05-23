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

// Effect names — every effectful operation belongs to one of these categories.
// Functions carry the union of effects they (transitively) perform.
export type EffectName = 'io' | 'pause' | 'time' | 'random' | 'net' | 'fs' | 'panic';
export type EffectSet = Set<EffectName>;
export const PURE: EffectSet = new Set();

export function effectsUnion(...es: EffectSet[]): EffectSet {
  const out: EffectSet = new Set();
  for (const e of es) for (const v of e) out.add(v);
  return out;
}

export function effectsStr(e: EffectSet): string {
  if (e.size === 0) return 'pure';
  return `[${[...e].sort().join(', ')}]`;
}

export type Type =
  | { kind: 'int' }
  | { kind: 'bool' }
  | { kind: 'str' }
  | { kind: 'unit' }
  | { kind: 'list' }
  | { kind: 'dict' }
  | { kind: 'fn'; params: Type[]; ret: Type; effects: EffectSet }
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

// Builtin-name → effects performed when called.
const BUILTIN_EFFECTS: Record<string, EffectSet> = {
  print:      new Set(['io']),
  net_fetch:  new Set(['net']),
  now:        new Set(['time']),
  random_int: new Set(['random']),
  read_file:  new Set(['fs']),
  write_file: new Set(['fs']),
  wait_until: new Set(['pause', 'time']),
  wait_for:   new Set(['pause']),
  panic:      new Set(['panic']),
  // everything else (str_*, list_*, dict_*, char_*, to_str, type_of, int_of_str) — pure
};
export function builtinEffects(name: string): EffectSet {
  return BUILTIN_EFFECTS[name] ?? PURE;
}

// Helper to construct a fn type with an effect set lifted from BUILTIN_EFFECTS.
function fnT(params: Type[], ret: Type, name: string): Type {
  return { kind: 'fn', params, ret, effects: builtinEffects(name) };
}
const BUILTIN_SIGS: Record<string, Type> = {
  // Effects
  print:       fnT([T_UNKNOWN], T_UNIT, 'print'),
  net_fetch:   fnT([T_STR], T_STR, 'net_fetch'),
  now:         fnT([], T_INT, 'now'),
  random_int:  fnT([T_INT, T_INT], T_INT, 'random_int'),
  read_file:   fnT([T_STR], T_STR, 'read_file'),
  write_file:  fnT([T_STR, T_STR], T_UNIT, 'write_file'),
  wait_until:  fnT([T_INT], T_UNIT, 'wait_until'),
  wait_for:    fnT([T_STR], T_UNKNOWN, 'wait_for'),
  // Pure builtins
  str_length:  fnT([T_STR], T_INT, 'str_length'),
  str_slice:   fnT([T_STR, T_INT, T_INT], T_STR, 'str_slice'),
  to_str:      fnT([T_UNKNOWN], T_STR, 'to_str'),
  list_new:    fnT([], T_LIST, 'list_new'),   // varargs handled below
  list_push:   fnT([T_LIST, T_UNKNOWN], T_LIST, 'list_push'),
  list_get:    fnT([T_LIST, T_INT], T_UNKNOWN, 'list_get'),
  list_set:    fnT([T_LIST, T_INT, T_UNKNOWN], T_LIST, 'list_set'),
  list_len:    fnT([T_LIST], T_INT, 'list_len'),
  list_slice:  fnT([T_LIST, T_INT, T_INT], T_LIST, 'list_slice'),
  dict_new:    fnT([], T_DICT, 'dict_new'),
  dict_set:    fnT([T_DICT, T_STR, T_UNKNOWN], T_DICT, 'dict_set'),
  dict_get:    fnT([T_DICT, T_STR], T_UNKNOWN, 'dict_get'),
  dict_has:    fnT([T_DICT, T_STR], T_BOOL, 'dict_has'),
  dict_keys:   fnT([T_DICT], T_LIST, 'dict_keys'),
  // String introspection
  str_chars:        fnT([T_STR], T_LIST, 'str_chars'),
  str_at:           fnT([T_STR, T_INT], T_STR, 'str_at'),
  str_find:         fnT([T_STR, T_STR], T_INT, 'str_find'),
  str_starts_with:  fnT([T_STR, T_STR], T_BOOL, 'str_starts_with'),
  str_ends_with:    fnT([T_STR, T_STR], T_BOOL, 'str_ends_with'),
  int_of_str:       fnT([T_STR], T_INT, 'int_of_str'),
  // List helpers
  list_concat:  fnT([T_LIST, T_LIST], T_LIST, 'list_concat'),
  list_reverse: fnT([T_LIST], T_LIST, 'list_reverse'),
  // Char predicates
  char_is_digit:      fnT([T_STR], T_BOOL, 'char_is_digit'),
  char_is_alpha:      fnT([T_STR], T_BOOL, 'char_is_alpha'),
  char_is_alphanum:   fnT([T_STR], T_BOOL, 'char_is_alphanum'),
  char_is_whitespace: fnT([T_STR], T_BOOL, 'char_is_whitespace'),
  // Control
  panic:    fnT([T_STR], T_UNIT, 'panic'),
  // Introspection
  type_of:  fnT([T_UNKNOWN], T_STR, 'type_of'),
};

const VARARG_BUILTINS = new Set(['list_new']);

// CheckCtx threads two side outputs through the recursion: errors list, and
// (optionally) a per-node types map and per-node effects map. The map writes are
// the only side effects of checking; the return value is the expression's type.
type CheckCtx = {
  errors: TypeError[];
  types?: Map<string, Type>;
  effects?: Map<string, EffectSet>;
};

export function check(ast: ASTBundle): TypeError[] {
  const ctx: CheckCtx = { errors: [], types: new Map(), effects: new Map() };
  checkNode(ast.nodes[ast.rootId], ast, new Map(), ctx);
  return ctx.errors;
}

// Like check, but also returns the inferred type for each AST node.
export function checkWithTypes(ast: ASTBundle): { errors: TypeError[]; types: Map<string, Type> } {
  const ctx: CheckCtx = { errors: [], types: new Map(), effects: new Map() };
  checkNode(ast.nodes[ast.rootId], ast, new Map(), ctx);
  return { errors: ctx.errors, types: ctx.types! };
}

// Returns errors, per-node types, AND per-node effect sets. Used by the
// CLI's `--show-effects` flag and by downstream passes (e.g. the JIT).
export function checkWithEffects(ast: ASTBundle): {
  errors: TypeError[]; types: Map<string, Type>; effects: Map<string, EffectSet>;
} {
  const ctx: CheckCtx = { errors: [], types: new Map(), effects: new Map() };
  checkNode(ast.nodes[ast.rootId], ast, new Map(), ctx);
  return { errors: ctx.errors, types: ctx.types!, effects: ctx.effects! };
}

// Per-node result the checker returns internally: the type AND the effects
// performed when the expression is evaluated.
type NodeResult = { type: Type; effects: EffectSet };

function pure(t: Type): NodeResult { return { type: t, effects: PURE }; }

function checkNode(node: ASTNode, ast: ASTBundle, env: Env, ctx: CheckCtx): Type {
  const r = checkNodeR(node, ast, env, ctx);
  if (ctx.types) ctx.types.set(node.id, r.type);
  if (ctx.effects) ctx.effects.set(node.id, r.effects);
  return r.type;
}

// Same as checkNode, but returns the full NodeResult instead of just the type.
// Callers that need to propagate effects up (most places) use this directly.
function checkNodeR(node: ASTNode, ast: ASTBundle, env: Env, ctx: CheckCtx): NodeResult {
  const r = dispatchNode(node, ast, env, ctx);
  if (ctx.types) ctx.types.set(node.id, r.type);
  if (ctx.effects) ctx.effects.set(node.id, r.effects);
  return r;
}

function dispatchNode(node: ASTNode, ast: ASTBundle, env: Env, ctx: CheckCtx): NodeResult {
  switch (node.kind) {
    case 'Program': {
      let eff: EffectSet = PURE;
      for (const id of node.stmtIds) {
        eff = effectsUnion(eff, checkNodeR(ast.nodes[id], ast, env, ctx).effects);
      }
      return { type: T_UNIT, effects: eff };
    }
    case 'IntLit':    return pure(T_INT);
    case 'BoolLit':   return pure(T_BOOL);
    case 'StringLit': return pure(T_STR);
    case 'UnitLit':   return pure(T_UNIT);
    case 'Pause':     return { type: T_UNIT, effects: new Set(['pause']) };
    case 'Var': {
      const t = env.get(node.name);
      if (!t) {
        ctx.errors.push({ message: `undefined variable '${node.name}'`, pos: node.pos });
        return pure(T_UNKNOWN);
      }
      return pure(t);
    }
    case 'ExprStmt': {
      const r = checkNodeR(ast.nodes[node.exprId], ast, env, ctx);
      return { type: T_UNIT, effects: r.effects };
    }
    case 'Let': {
      const r = checkNodeR(ast.nodes[node.valueId], ast, env, ctx);
      env.set(node.name, r.type);
      return { type: T_UNIT, effects: r.effects };
    }
    case 'BinOp':    return checkBinOp(node, ast, env, ctx);
    case 'If':       return checkIf(node, ast, env, ctx);
    case 'Block':    return checkBlock(node, ast, env, ctx);
    case 'Fn':       return checkFn(node, ast, env, ctx);
    case 'Call':     return checkCall(node, ast, env, ctx);
    case 'Match':    return checkMatch(node, ast, env, ctx);
    default: {
      const n = node as ASTNode;
      ctx.errors.push({ message: `typecheck: unhandled node kind '${n.kind}'`, pos: n.pos });
      return pure(T_UNKNOWN);
    }
  }
}

function checkBinOp(node: Extract<ASTNode, { kind: 'BinOp' }>, ast: ASTBundle, env: Env, ctx: CheckCtx): NodeResult {
  const l = checkNodeR(ast.nodes[node.leftId], ast, env, ctx);
  const r = checkNodeR(ast.nodes[node.rightId], ast, env, ctx);
  const eff = effectsUnion(l.effects, r.effects);
  const left = l.type, right = r.type;
  const op = node.op as BinOp;
  if (op === '+') {
    if (matches(left, T_INT) && matches(right, T_INT)) return { type: T_INT, effects: eff };
    if (matches(left, T_STR) && matches(right, T_STR)) return { type: T_STR, effects: eff };
    if (left.kind !== 'unknown' && right.kind !== 'unknown') {
      ctx.errors.push({ message: `binop '+' requires int+int or str+str, got ${typeStr(left)}+${typeStr(right)}`, pos: node.pos });
    }
    return { type: T_UNKNOWN, effects: eff };
  }
  if (op === '-' || op === '*' || op === '/') {
    if (!matches(left, T_INT) || !matches(right, T_INT)) {
      if (left.kind !== 'unknown' && right.kind !== 'unknown') {
        ctx.errors.push({ message: `binop '${op}' requires int, got ${typeStr(left)}+${typeStr(right)}`, pos: node.pos });
      }
    }
    return { type: T_INT, effects: eff };
  }
  if (op === '<' || op === '>' || op === '<=' || op === '>=') {
    if (!matches(left, T_INT) || !matches(right, T_INT)) {
      if (left.kind !== 'unknown' && right.kind !== 'unknown') {
        ctx.errors.push({ message: `binop '${op}' requires int, got ${typeStr(left)}+${typeStr(right)}`, pos: node.pos });
      }
    }
    return { type: T_BOOL, effects: eff };
  }
  if (op === '==' || op === '!=') {
    if (left.kind !== 'unknown' && right.kind !== 'unknown' && left.kind !== right.kind) {
      ctx.errors.push({ message: `binop '${op}' type mismatch: ${typeStr(left)} vs ${typeStr(right)}`, pos: node.pos });
    }
    return { type: T_BOOL, effects: eff };
  }
  return { type: T_UNKNOWN, effects: eff };
}

function checkIf(node: Extract<ASTNode, { kind: 'If' }>, ast: ASTBundle, env: Env, ctx: CheckCtx): NodeResult {
  const c = checkNodeR(ast.nodes[node.condId], ast, env, ctx);
  if (!matches(c.type, T_BOOL) && c.type.kind !== 'unknown') {
    ctx.errors.push({ message: `if condition must be bool, got ${typeStr(c.type)}`, pos: ast.nodes[node.condId].pos });
  }
  const t = checkNodeR(ast.nodes[node.thenBlockId], ast, env, ctx);
  const e = checkNodeR(ast.nodes[node.elseBlockId], ast, env, ctx);
  const eff = effectsUnion(c.effects, t.effects, e.effects);
  const retT = (t.type.kind !== e.type.kind && t.type.kind !== 'unknown' && e.type.kind !== 'unknown')
    ? T_UNKNOWN
    : (t.type.kind !== 'unknown' ? t.type : e.type);
  return { type: retT, effects: eff };
}

function checkBlock(node: Extract<ASTNode, { kind: 'Block' }>, ast: ASTBundle, env: Env, ctx: CheckCtx): NodeResult {
  const local = new Map(env);
  let eff: EffectSet = PURE;
  for (const id of node.stmtIds) {
    eff = effectsUnion(eff, checkNodeR(ast.nodes[id], ast, local, ctx).effects);
  }
  if (node.trailingExprId !== null) {
    const r = checkNodeR(ast.nodes[node.trailingExprId], ast, local, ctx);
    return { type: r.type, effects: effectsUnion(eff, r.effects) };
  }
  return { type: T_UNIT, effects: eff };
}

function checkFn(node: Extract<ASTNode, { kind: 'Fn' }>, ast: ASTBundle, env: Env, ctx: CheckCtx): NodeResult {
  const body = ast.nodes[node.bodyBlockId];
  const local = new Map(env);
  const paramTypes: Type[] = [];
  for (const p of node.params) {
    local.set(p, T_UNKNOWN);
    paramTypes.push(T_UNKNOWN);
  }
  const bodyR = checkNodeR(body, ast, local, ctx);
  // A `pure fn` must have an empty effect set — otherwise the annotation lied.
  if (node.isPure && bodyR.effects.size > 0) {
    ctx.errors.push({
      message: `pure fn body has effects ${effectsStr(bodyR.effects)} — remove 'pure' or the effectful operations`,
      pos: node.pos,
    });
  }
  // The Fn LITERAL is itself a pure expression (it allocates a closure value
  // with no observable side effect). The fn's effect set lives ON its type.
  return { type: { kind: 'fn', params: paramTypes, ret: bodyR.type, effects: bodyR.effects }, effects: PURE };
}

function checkCall(node: Extract<ASTNode, { kind: 'Call' }>, ast: ASTBundle, env: Env, ctx: CheckCtx): NodeResult {
  const callee = ast.nodes[node.calleeId];
  // Builtin-name fast path: use BUILTIN_SIGS (already carries effects).
  if (callee.kind === 'Var' && callee.name in BUILTIN_SIGS) {
    const sig = BUILTIN_SIGS[callee.name];
    if (sig.kind !== 'fn') return pure(T_UNKNOWN);
    if (!VARARG_BUILTINS.has(callee.name) && node.argIds.length !== sig.params.length) {
      ctx.errors.push({
        message: `${callee.name}: expected ${sig.params.length} args, got ${node.argIds.length}`,
        pos: node.pos,
      });
    }
    let eff: EffectSet = sig.effects;
    for (let i = 0; i < node.argIds.length; i++) {
      const ar = checkNodeR(ast.nodes[node.argIds[i]], ast, env, ctx);
      eff = effectsUnion(eff, ar.effects);
      const exp = sig.params[i] ?? T_UNKNOWN;
      if (!matches(ar.type, exp) && ar.type.kind !== 'unknown' && exp.kind !== 'unknown') {
        ctx.errors.push({
          message: `${callee.name}: arg ${i + 1} expected ${typeStr(exp)}, got ${typeStr(ar.type)}`,
          pos: ast.nodes[node.argIds[i]].pos,
        });
      }
    }
    return { type: sig.ret, effects: eff };
  }
  const calleeR = checkNodeR(callee, ast, env, ctx);
  if (calleeR.type.kind === 'unknown') {
    let eff = calleeR.effects;
    for (const id of node.argIds) eff = effectsUnion(eff, checkNodeR(ast.nodes[id], ast, env, ctx).effects);
    return { type: T_UNKNOWN, effects: eff };
  }
  if (calleeR.type.kind !== 'fn') {
    ctx.errors.push({ message: `call: callee is ${typeStr(calleeR.type)}, not a function`, pos: node.pos });
    return pure(T_UNKNOWN);
  }
  if (calleeR.type.params.length !== node.argIds.length) {
    ctx.errors.push({
      message: `call: arity mismatch — expected ${calleeR.type.params.length}, got ${node.argIds.length}`,
      pos: node.pos,
    });
  }
  let eff: EffectSet = effectsUnion(calleeR.effects, calleeR.type.effects);
  for (let i = 0; i < node.argIds.length; i++) {
    eff = effectsUnion(eff, checkNodeR(ast.nodes[node.argIds[i]], ast, env, ctx).effects);
  }
  return { type: calleeR.type.ret, effects: eff };
}

function checkMatch(node: Extract<ASTNode, { kind: 'Match' }>, ast: ASTBundle, env: Env, ctx: CheckCtx): NodeResult {
  const scrut = checkNodeR(ast.nodes[node.scrutineeId], ast, env, ctx);
  let eff = scrut.effects;
  let firstType: Type | null = null;
  let allSame = true;
  for (const arm of node.arms) {
    // Pattern bindings: introduce vars in a child env, typed as unknown.
    const local = new Map(env);
    collectPatternBindings(arm.pattern, local);
    if (arm.guardId !== undefined) {
      eff = effectsUnion(eff, checkNodeR(ast.nodes[arm.guardId], ast, local, ctx).effects);
    }
    const armR = checkNodeR(ast.nodes[arm.bodyId], ast, local, ctx);
    eff = effectsUnion(eff, armR.effects);
    if (firstType === null) firstType = armR.type;
    else if (firstType.kind !== armR.type.kind) allSame = false;
  }
  return { type: (allSame && firstType !== null) ? firstType : T_UNKNOWN, effects: eff };
}

function collectPatternBindings(pat: import('./ast.js').Pattern, env: Env): void {
  switch (pat.kind) {
    case 'var':      env.set(pat.name, T_UNKNOWN); return;
    case 'or':       for (const p of pat.patterns) collectPatternBindings(p, env); return;
    case 'list':     for (const p of pat.items) collectPatternBindings(p, env); if (pat.rest) env.set(pat.rest, T_LIST); return;
    case 'dict':     for (const e of pat.entries) collectPatternBindings(e.pattern, env); return;
    default:         return;
  }
}

function matches(a: Type, b: Type): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown') return true;
  return a.kind === b.kind;
}

export function typeStr(t: Type): string {
  if (t.kind === 'fn') {
    const eff = t.effects.size === 0 ? '' : ` / ${effectsStr(t.effects)}`;
    return `fn(${t.params.map(typeStr).join(', ')}) -> ${typeStr(t.ret)}${eff}`;
  }
  return t.kind;
}

export function formatErrors(errors: TypeError[]): string {
  return errors.map(e => {
    const at = e.pos ? ` at line ${e.pos.line} col ${e.pos.col}` : '';
    return `type error: ${e.message}${at}`;
  }).join('\n');
}
