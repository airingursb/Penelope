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
    default:
      return { kind: 'error', message: `unimplemented eval kind: ${(node as ASTNode).kind}`, atNode: node.id };
  }
}

function cont(state: State): StepResult {
  return { kind: 'continue' as const, state };
}
