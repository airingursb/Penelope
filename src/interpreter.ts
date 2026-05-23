// Penelope step-machine interpreter.
// step(state, ast): pure function over plain JSON-serializable data.
// runToCompletion drives step in a loop until done | paused | error.
//
// CORE INVARIANT: every field in State must be JSON-serializable.
// No closures, no Maps, no symbols, no class instances.

import type { ASTBundle, ASTNode, BinOp, NodeId, ScopeId, Value } from './ast.js';

// ============================================================
// State
// ============================================================

export type Scope = {
  parentId: ScopeId | null;
  bindings: Record<string, Value>;
};

export type ControlInstr =
  | { op: 'eval';      nodeId: NodeId }
  | { op: 'applyBin';  binOp: BinOp }
  | { op: 'applyPrint' }
  | { op: 'bindLet';   name: string }
  | { op: 'branch';    thenBlockId: NodeId; elseBlockId: NodeId }
  | { op: 'invoke';    argCount: number }
  | { op: 'popScope';  restoreScopeId: ScopeId }
  | { op: 'pushUnit' }
  | { op: 'discard' };

export type State = {
  control: ControlInstr[];
  valueStack: Value[];
  scopes: Record<ScopeId, Scope>;
  currentScopeId: ScopeId;
  nextScopeIdCounter: number;
};

export type StepResult =
  | { kind: 'continue'; state: State }
  | { kind: 'done';     finalValue: Value | null }
  | { kind: 'paused';   state: State; pausedAt: NodeId }
  | { kind: 'error';    message: string; atNode?: NodeId };

// ============================================================
// Construction
// ============================================================

export function initialState(rootId: NodeId): State {
  return {
    control: [{ op: 'eval', nodeId: rootId }],
    valueStack: [],
    scopes: { s0: { parentId: null, bindings: {} } },
    currentScopeId: 's0',
    nextScopeIdCounter: 1,
  };
}

// ============================================================
// Loop driver
// ============================================================

export function runToCompletion(ast: ASTBundle, startNodeId: NodeId = ast.rootId): StepResult {
  let state: State = {
    control: [{ op: 'eval', nodeId: startNodeId }],
    valueStack: [],
    scopes: { s0: { parentId: null, bindings: {} } },
    currentScopeId: 's0',
    nextScopeIdCounter: 1,
  };
  while (true) {
    const r = step(state, ast);
    if (r.kind === 'continue') { state = r.state; continue; }
    return r;
  }
}

// ============================================================
// step()
// ============================================================

export function step(state: State, ast: ASTBundle): StepResult {
  if (state.control.length === 0) {
    return {
      kind: 'done',
      finalValue: state.valueStack.length > 0
        ? state.valueStack[state.valueStack.length - 1]
        : null,
    };
  }

  const instr = state.control[state.control.length - 1];
  const rest = state.control.slice(0, -1);

  switch (instr.op) {
    case 'eval':
      return stepEval(state, rest, ast.nodes[instr.nodeId], ast);
    case 'applyBin':
      return applyBinOp(state, rest, instr.binOp);
    default:
      return { kind: 'error', message: `unimplemented op: ${(instr as ControlInstr).op}` };
  }
}

function stepEval(state: State, rest: ControlInstr[], node: ASTNode, _ast: ASTBundle): StepResult {
  switch (node.kind) {
    case 'IntLit':
      return cont({ ...state, control: rest,
        valueStack: [...state.valueStack, { tag: 'int', v: node.value }] });
    case 'BoolLit':
      return cont({ ...state, control: rest,
        valueStack: [...state.valueStack, { tag: 'bool', v: node.value }] });
    case 'Var': {
      const v = lookup(state.scopes, state.currentScopeId, node.name);
      if (v === undefined)
        return { kind: 'error', message: `undefined variable '${node.name}'`, atNode: node.id };
      return cont({ ...state, control: rest,
        valueStack: [...state.valueStack, v] });
    }
    case 'BinOp':
      return cont({ ...state, control: [
        ...rest,
        { op: 'applyBin', binOp: node.op },
        { op: 'eval', nodeId: node.rightId },
        { op: 'eval', nodeId: node.leftId },
      ]});
    default:
      return { kind: 'error', message: `unimplemented eval kind: ${(node as ASTNode).kind}`, atNode: node.id };
  }
}

function cont(state: State): StepResult {
  return { kind: 'continue' as const, state };
}

function lookup(scopes: Record<ScopeId, Scope>, scopeId: ScopeId, name: string): Value | undefined {
  let cur: ScopeId | null = scopeId;
  while (cur !== null) {
    const sc: Scope = scopes[cur];
    if (name in sc.bindings) return sc.bindings[name];
    cur = sc.parentId;
  }
  return undefined;
}

function applyBinOp(state: State, rest: ControlInstr[], op: BinOp): StepResult {
  const stack = state.valueStack;
  const right = stack[stack.length - 1];
  const left  = stack[stack.length - 2];
  const newStack = stack.slice(0, -2);

  if (op === '+' || op === '-' || op === '*' || op === '/') {
    if (left.tag !== 'int' || right.tag !== 'int')
      return { kind: 'error', message: `cannot apply '${op}' to ${left.tag} and ${right.tag}` };
    let result: number;
    if (op === '+') result = left.v + right.v;
    else if (op === '-') result = left.v - right.v;
    else if (op === '*') result = left.v * right.v;
    else {
      if (right.v === 0) return { kind: 'error', message: 'division by zero' };
      result = Math.trunc(left.v / right.v);
    }
    return cont({ ...state, control: rest,
      valueStack: [...newStack, { tag: 'int', v: result }] });
  }

  if (op === '<' || op === '<=' || op === '>' || op === '>=') {
    if (left.tag !== 'int' || right.tag !== 'int')
      return { kind: 'error', message: `cannot apply '${op}' to ${left.tag} and ${right.tag}` };
    let result: boolean;
    if (op === '<') result = left.v < right.v;
    else if (op === '<=') result = left.v <= right.v;
    else if (op === '>') result = left.v > right.v;
    else result = left.v >= right.v;
    return cont({ ...state, control: rest,
      valueStack: [...newStack, { tag: 'bool', v: result }] });
  }

  if (op === '==' || op === '!=') {
    if (left.tag !== right.tag)
      return { kind: 'error', message: `cannot apply '${op}' to ${left.tag} and ${right.tag}` };
    let same: boolean;
    if (left.tag === 'int' && right.tag === 'int') same = left.v === right.v;
    else if (left.tag === 'bool' && right.tag === 'bool') same = left.v === right.v;
    else if (left.tag === 'unit' && right.tag === 'unit') same = true;
    else return { kind: 'error', message: `cannot compare ${left.tag} values` };
    return cont({ ...state, control: rest,
      valueStack: [...newStack, { tag: 'bool', v: op === '==' ? same : !same }] });
  }

  return { kind: 'error', message: `unknown binary op: ${op}` };
}
