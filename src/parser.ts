// Penelope parser.
// Hand-written recursive descent. Assigns NodeIds deterministically via
// a DFS counter so that re-parsing the same source produces identical IDs
// (essential for snapshot resume).

import type { Token, TokenKind } from './lexer.js';
import { tokenize } from './lexer.js';
import type { ASTNode, NodeId, ASTBundle, BinOp } from './ast.js';

// Precedence table. Higher number binds tighter.
//   1: == !=
//   2: <  <=  >  >=
//   3: +  -
//   4: *  /
const INFIX_PRECEDENCE: Partial<Record<TokenKind, { prec: number; op: BinOp }>> = {
  EQ_EQ:   { prec: 1, op: '==' },
  BANG_EQ: { prec: 1, op: '!=' },
  LT:      { prec: 2, op: '<' },
  LE:      { prec: 2, op: '<=' },
  GT:      { prec: 2, op: '>' },
  GE:      { prec: 2, op: '>=' },
  PLUS:    { prec: 3, op: '+' },
  MINUS:   { prec: 3, op: '-' },
  STAR:    { prec: 4, op: '*' },
  SLASH:   { prec: 4, op: '/' },
};

type Builder = {
  nodes: Record<NodeId, ASTNode>;
  counter: number;
  addNode<T extends ASTNode>(make: (id: NodeId) => T, pos?: { line: number; col: number }): T;
};

function makeBuilder(): Builder {
  const b: Builder = {
    nodes: {},
    counter: 0,
    addNode<T extends ASTNode>(make: (id: NodeId) => T, pos?: { line: number; col: number }): T {
      const id = `n${b.counter++}`;
      const node = make(id);
      if (pos) (node as ASTNode).pos = pos;
      b.nodes[id] = node;
      return node;
    },
  };
  return b;
}

type Cursor = {
  tokens: Token[];
  pos: number;
  peek(): Token;
  peekKind(): TokenKind;
  eat(kind: TokenKind): Token;
  match(kind: TokenKind): boolean;
};

function makeCursor(tokens: Token[]): Cursor {
  const c: Cursor = {
    tokens,
    pos: 0,
    peek() { return c.tokens[c.pos]; },
    peekKind() { return c.tokens[c.pos].kind; },
    eat(kind) {
      const t = c.tokens[c.pos];
      if (t.kind !== kind) {
        throw new Error(`parser: expected ${kind} at line ${t.line} col ${t.col}, got ${t.kind}`);
      }
      c.pos++;
      return t;
    },
    match(kind) {
      if (c.tokens[c.pos].kind === kind) { c.pos++; return true; }
      return false;
    },
  };
  return c;
}

export function parse(tokens: Token[]): ASTBundle {
  const b = makeBuilder();
  const c = makeCursor(tokens);

  const stmtIds: NodeId[] = [];
  while (c.peekKind() !== 'EOF') {
    // Tolerate bare `import "..."` statements (already expanded by the loader)
    if (c.peekKind() === 'IMPORT') {
      c.eat('IMPORT');
      c.eat('STRING');
      c.eat('SEMI');
      continue;
    }
    stmtIds.push(parseStatement(c, b).id);
  }

  const program = b.addNode(id => ({ id, kind: 'Program', stmtIds }));
  return { rootId: program.id, nodes: b.nodes };
}

function parseStatement(c: Cursor, b: Builder): ASTNode {
  // For now, every top-level statement is either a let or an expr-stmt.
  if (c.peekKind() === 'LET') return parseLetStmt(c, b);
  return parseExprStmt(c, b);
}

function parseExprStmt(c: Cursor, b: Builder): ASTNode {
  const startTok = c.peek();
  const pos = { line: startTok.line, col: startTok.col };
  const expr = parseExpression(c, b);
  c.eat('SEMI');
  return b.addNode(id => ({ id, kind: 'ExprStmt', exprId: expr.id }), pos);
}

function parseLetStmt(c: Cursor, b: Builder): ASTNode {
  const startTok = c.peek();
  const pos = { line: startTok.line, col: startTok.col };
  c.eat('LET');
  const nameTok = c.eat('IDENT');
  c.eat('EQ');
  const value = parseExpression(c, b);
  c.eat('SEMI');
  return b.addNode(id => ({ id, kind: 'Let', name: nameTok.text!, valueId: value.id }), pos);
}

function parseExpression(c: Cursor, b: Builder, minPrec = 0): ASTNode {
  let left = parsePostfix(c, b);
  while (true) {
    const info = INFIX_PRECEDENCE[c.peekKind()];
    if (!info || info.prec < minPrec) break;
    const opTok = c.peek();
    const pos = { line: opTok.line, col: opTok.col };
    c.eat(c.peekKind());                              // consume the operator
    const right = parseExpression(c, b, info.prec + 1);  // left-assoc
    const node = b.addNode(id => ({
      id, kind: 'BinOp', op: info.op, leftId: left.id, rightId: right.id,
    }), pos);
    left = node;
  }
  return left;
}

function parsePostfix(c: Cursor, b: Builder): ASTNode {
  let expr = parsePrimary(c, b);
  while (c.peekKind() === 'LPAREN') {
    const parenTok = c.peek();
    const pos = { line: parenTok.line, col: parenTok.col };
    c.eat('LPAREN');
    const argIds: NodeId[] = [];
    if (c.peekKind() !== 'RPAREN') {
      argIds.push(parseExpression(c, b).id);
      while (c.match('COMMA')) argIds.push(parseExpression(c, b).id);
    }
    c.eat('RPAREN');
    const call = b.addNode(id => ({ id, kind: 'Call', calleeId: expr.id, argIds }), pos);
    expr = call;
  }
  return expr;
}

function parseBlock(c: Cursor, b: Builder): ASTNode {
  const startTok = c.peek();
  const pos = { line: startTok.line, col: startTok.col };
  c.eat('LBRACE');
  const stmtIds: NodeId[] = [];
  let trailingExprId: NodeId | null = null;

  while (c.peekKind() !== 'RBRACE') {
    if (c.peekKind() === 'LET') {
      stmtIds.push(parseLetStmt(c, b).id);
      continue;
    }
    const exprStartTok = c.peek();
    const exprPos = { line: exprStartTok.line, col: exprStartTok.col };
    const expr = parseExpression(c, b);
    if (c.peekKind() === 'SEMI') {
      c.eat('SEMI');
      const stmt = b.addNode(id => ({ id, kind: 'ExprStmt', exprId: expr.id }), exprPos);
      stmtIds.push(stmt.id);
    } else if (c.peekKind() === 'RBRACE') {
      trailingExprId = expr.id;
      break;
    } else {
      const t = c.peek();
      throw new Error(`parser: expected ';' or '}' after expression at line ${t.line} col ${t.col}, got ${t.kind}`);
    }
  }

  c.eat('RBRACE');
  return b.addNode(id => ({ id, kind: 'Block', stmtIds, trailingExprId }), pos);
}

function parseIf(c: Cursor, b: Builder): ASTNode {
  const startTok = c.peek();
  const pos = { line: startTok.line, col: startTok.col };
  c.eat('IF');
  c.eat('LPAREN');
  const cond = parseExpression(c, b);
  c.eat('RPAREN');
  const thenBlock = parseBlock(c, b);
  c.eat('ELSE');
  const elseBlock = parseBlock(c, b);
  return b.addNode(id => ({
    id, kind: 'If',
    condId: cond.id,
    thenBlockId: thenBlock.id,
    elseBlockId: elseBlock.id,
  }), pos);
}

function parseMatch(c: Cursor, b: Builder): ASTNode {
  const startTok = c.peek();
  const pos = { line: startTok.line, col: startTok.col };
  c.eat('MATCH');
  const scrutinee = parseExpression(c, b);
  c.eat('LBRACE');
  const arms: import('./ast.js').MatchArm[] = [];
  while (c.peekKind() !== 'RBRACE') {
    const pattern = parsePattern(c);
    c.eat('FAT_ARROW');
    const body = parseExpression(c, b);
    arms.push({ pattern, bodyId: body.id });
    if (c.peekKind() === 'COMMA') c.eat('COMMA');
  }
  c.eat('RBRACE');
  if (arms.length === 0) {
    throw new Error(`parser: match must have at least one arm at line ${pos.line} col ${pos.col}`);
  }
  return b.addNode(id => ({
    id, kind: 'Match', scrutineeId: scrutinee.id, arms,
  }), pos);
}

function parsePattern(c: Cursor): import('./ast.js').Pattern {
  const t = c.peek();
  if (t.kind === 'INT') {
    c.eat('INT');
    return { kind: 'int', value: t.value! };
  }
  if (t.kind === 'TRUE')  { c.eat('TRUE');  return { kind: 'bool', value: true  }; }
  if (t.kind === 'FALSE') { c.eat('FALSE'); return { kind: 'bool', value: false }; }
  if (t.kind === 'STRING') { c.eat('STRING'); return { kind: 'str', value: t.text! }; }
  if (t.kind === 'IDENT') {
    c.eat('IDENT');
    if (t.text === '_') return { kind: 'wildcard' };
    return { kind: 'var', name: t.text! };
  }
  throw new Error(`parser: unexpected pattern token ${t.kind} at line ${t.line} col ${t.col}`);
}

function parseFn(c: Cursor, b: Builder): ASTNode {
  const startTok = c.peek();
  const pos = { line: startTok.line, col: startTok.col };
  c.eat('FN');
  c.eat('LPAREN');
  const params: string[] = [];
  if (c.peekKind() !== 'RPAREN') {
    params.push(c.eat('IDENT').text!);
    while (c.match('COMMA')) params.push(c.eat('IDENT').text!);
  }
  c.eat('RPAREN');
  const body = parseBlock(c, b);
  return b.addNode(id => ({ id, kind: 'Fn', params, bodyBlockId: body.id }), pos);
}

function parsePrimary(c: Cursor, b: Builder): ASTNode {
  const t = c.peek();
  const pos = { line: t.line, col: t.col };
  switch (t.kind) {
    case 'INT': {
      c.eat('INT');
      return b.addNode(id => ({ id, kind: 'IntLit', value: t.value! }), pos);
    }
    case 'STRING': {
      c.eat('STRING');
      return b.addNode(id => ({ id, kind: 'StringLit', value: t.text! }), pos);
    }
    case 'TEMPLATE_STRING': {
      c.eat('TEMPLATE_STRING');
      return buildTemplateString(t.parts!, b, pos);
    }
    case 'TRUE':
      c.eat('TRUE');
      return b.addNode(id => ({ id, kind: 'BoolLit', value: true }), pos);
    case 'FALSE':
      c.eat('FALSE');
      return b.addNode(id => ({ id, kind: 'BoolLit', value: false }), pos);
    case 'IDENT': {
      c.eat('IDENT');
      return b.addNode(id => ({ id, kind: 'Var', name: t.text! }), pos);
    }
    case 'PAUSE':
      c.eat('PAUSE');
      return b.addNode(id => ({ id, kind: 'Pause' }), pos);
    case 'IF':
      return parseIf(c, b);
    case 'FN':
      return parseFn(c, b);
    case 'MATCH':
      return parseMatch(c, b);
    case 'LPAREN': {
      c.eat('LPAREN');
      // Empty parens () = unit literal
      if (c.peekKind() === 'RPAREN') {
        c.eat('RPAREN');
        // Desugar `()` as a Var lookup for a synthetic name that the compiler
        // turns into PUSH_UNIT. Simpler: model as a Call to a builtin-ish.
        // Cleanest: introduce an Unit AST literal via an IntLit hack — too gross.
        // Just compile to PUSH_UNIT: re-use the existing Pause-shaped no-arg node.
        // We add a 'UnitLit' kind in ast.ts.
        return b.addNode(id => ({ id, kind: 'UnitLit' } as ASTNode), pos);
      }
      const inner = parseExpression(c, b);
      c.eat('RPAREN');
      return inner;
    }
    case 'MINUS': {
      // Unary minus.  -<int_literal>  folds to a negative IntLit.
      // -<expr>  desugars to (0 - expr).
      c.eat('MINUS');
      const next = c.peek();
      if (next.kind === 'INT') {
        c.eat('INT');
        return b.addNode(id => ({ id, kind: 'IntLit', value: -next.value! }), pos);
      }
      const zero = b.addNode(id => ({ id, kind: 'IntLit', value: 0 }), pos);
      const operand = parsePrimary(c, b);
      return b.addNode(id => ({ id, kind: 'BinOp', op: '-', leftId: zero.id, rightId: operand.id }), pos);
    }
    default:
      throw new Error(`parser: unexpected token ${t.kind} at line ${t.line} col ${t.col}`);
  }
}

// Desugar a template string into a `+` chain of StringLits and to_str(expr) calls.
// "a${x}b" → "a" + to_str(x) + "b"
function buildTemplateString(
  parts: import('./lexer.js').TemplatePart[],
  b: Builder,
  pos: { line: number; col: number },
): ASTNode {
  if (parts.length === 0) {
    return b.addNode(id => ({ id, kind: 'StringLit', value: '' }), pos);
  }
  const nodes: ASTNode[] = parts.map(part => {
    if (part.kind === 'text') {
      return b.addNode(id => ({ id, kind: 'StringLit', value: part.value }), pos);
    }
    // Tokenize + parse the expression source as a standalone fragment.
    const exprTokens = tokenize(part.source + ';');
    const exprBundle = parse(exprTokens);
    // exprBundle is a Program with one ExprStmt — extract the inner expression
    // and re-import its nodes into this builder.
    const inner = importExpression(exprBundle, b);
    // Wrap in to_str(...)
    const calleeName = b.addNode(id => ({ id, kind: 'Var', name: 'to_str' }), pos);
    return b.addNode(id => ({
      id, kind: 'Call', calleeId: calleeName.id, argIds: [inner.id],
    }), pos);
  });
  // Fold with `+`
  return nodes.reduce((acc, n) => b.addNode(id => ({
    id, kind: 'BinOp', op: '+', leftId: acc.id, rightId: n.id,
  }), pos));
}

// Copy the (single) expression out of a freshly-parsed Program into the host builder.
function importExpression(bundle: import('./ast.js').ASTBundle, b: Builder): ASTNode {
  const program = bundle.nodes[bundle.rootId];
  if (program.kind !== 'Program' || program.stmtIds.length !== 1) {
    throw new Error(`template: expected a single expression`);
  }
  const stmt = bundle.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error(`template: expected expression`);
  return importNode(bundle, b, stmt.exprId);
}

function importNode(bundle: import('./ast.js').ASTBundle, b: Builder, id: import('./ast.js').NodeId): ASTNode {
  const src = bundle.nodes[id];
  // Deep-copy the node, remapping child ids via recursive import.
  switch (src.kind) {
    case 'IntLit':    return b.addNode(nid => ({ id: nid, kind: 'IntLit', value: src.value }), src.pos);
    case 'BoolLit':   return b.addNode(nid => ({ id: nid, kind: 'BoolLit', value: src.value }), src.pos);
    case 'StringLit': return b.addNode(nid => ({ id: nid, kind: 'StringLit', value: src.value }), src.pos);
    case 'Pause':     return b.addNode(nid => ({ id: nid, kind: 'Pause' }), src.pos);
    case 'Var':       return b.addNode(nid => ({ id: nid, kind: 'Var', name: src.name }), src.pos);
    case 'BinOp': {
      const l = importNode(bundle, b, src.leftId);
      const r = importNode(bundle, b, src.rightId);
      return b.addNode(nid => ({ id: nid, kind: 'BinOp', op: src.op, leftId: l.id, rightId: r.id }), src.pos);
    }
    case 'Call': {
      const callee = importNode(bundle, b, src.calleeId);
      const args = src.argIds.map(a => importNode(bundle, b, a).id);
      return b.addNode(nid => ({ id: nid, kind: 'Call', calleeId: callee.id, argIds: args }), src.pos);
    }
    case 'If': {
      const cond = importNode(bundle, b, src.condId);
      const t = importNode(bundle, b, src.thenBlockId);
      const e = importNode(bundle, b, src.elseBlockId);
      return b.addNode(nid => ({ id: nid, kind: 'If', condId: cond.id, thenBlockId: t.id, elseBlockId: e.id }), src.pos);
    }
    case 'Block': {
      const stmts = src.stmtIds.map(s => importNode(bundle, b, s).id);
      const trailing = src.trailingExprId !== null ? importNode(bundle, b, src.trailingExprId).id : null;
      return b.addNode(nid => ({ id: nid, kind: 'Block', stmtIds: stmts, trailingExprId: trailing }), src.pos);
    }
    case 'Fn': {
      const body = importNode(bundle, b, src.bodyBlockId);
      return b.addNode(nid => ({ id: nid, kind: 'Fn', params: src.params, bodyBlockId: body.id }), src.pos);
    }
    default:
      throw new Error(`template: unsupported expression kind ${src.kind}`);
  }
}
