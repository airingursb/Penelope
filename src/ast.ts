// Penelope AST and Value types.
// Pure type definitions: no runtime code lives here.

export type NodeId = string;  // e.g., "n0", "n1", ... — assigned deterministically by parser

export type BinOp = '+' | '-' | '*' | '/' | '<' | '>' | '<=' | '>=' | '==' | '!=';

export type Pos = { line: number; col: number };

// ============================================================
// AST
// ============================================================

export type Pattern =
  | { kind: 'int';      value: number }
  | { kind: 'bool';     value: boolean }
  | { kind: 'str';      value: string }
  | { kind: 'var';      name: string }    // binds the scrutinee to `name`
  | { kind: 'wildcard' };                  // _ (matches anything, no binding)

export type MatchArm = { pattern: Pattern; bodyId: NodeId };

export type ASTNode = (
  | { id: NodeId; kind: 'IntLit';    value: number }
  | { id: NodeId; kind: 'BoolLit';   value: boolean }
  | { id: NodeId; kind: 'StringLit'; value: string }
  | { id: NodeId; kind: 'UnitLit' }
  | { id: NodeId; kind: 'Var';      name: string }
  | { id: NodeId; kind: 'BinOp';    op: BinOp; leftId: NodeId; rightId: NodeId }
  | { id: NodeId; kind: 'Let';      name: string; valueId: NodeId }
  | { id: NodeId; kind: 'If';       condId: NodeId; thenBlockId: NodeId; elseBlockId: NodeId }
  | { id: NodeId; kind: 'Fn';       params: string[]; bodyBlockId: NodeId }
  | { id: NodeId; kind: 'Call';     calleeId: NodeId; argIds: NodeId[] }
  | { id: NodeId; kind: 'Pause' }
  | { id: NodeId; kind: 'ExprStmt'; exprId: NodeId }
  | { id: NodeId; kind: 'Block';    stmtIds: NodeId[]; trailingExprId: NodeId | null }
  | { id: NodeId; kind: 'Program';  stmtIds: NodeId[] }
  | { id: NodeId; kind: 'Match';    scrutineeId: NodeId; arms: MatchArm[] }
) & { pos?: Pos };

export type ASTBundle = {
  rootId: NodeId;
  nodes: Record<NodeId, ASTNode>;
};

// ============================================================
// Runtime Values
// ============================================================

export type Value =
  | { tag: 'int';     v: number }
  | { tag: 'bool';    v: boolean }
  | { tag: 'closure'; params: string[]; bodyIp: number; bodyLen: number; capturedFrameIdx: number }
  | { tag: 'unit' }
  | { tag: 'str';     v: string }
  | { tag: 'list';    items: Value[] }
  | { tag: 'dict';    entries: Record<string, Value> };

export type ScopeId = string;  // e.g., "s0", "s1", ...
