// Penelope parser.
// Hand-written recursive descent. Assigns NodeIds deterministically via
// a DFS counter so that re-parsing the same source produces identical IDs
// (essential for snapshot resume).

import type { Token, TokenKind } from './lexer.js';
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
  addNode<T extends ASTNode>(make: (id: NodeId) => T): T;
};

function makeBuilder(): Builder {
  const b: Builder = {
    nodes: {},
    counter: 0,
    addNode<T extends ASTNode>(make: (id: NodeId) => T): T {
      const id = `n${b.counter++}`;
      const node = make(id);
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
    stmtIds.push(parseStatement(c, b).id);
  }

  const program = b.addNode(id => ({ id, kind: 'Program', stmtIds }));
  return { rootId: program.id, nodes: b.nodes };
}

function parseStatement(c: Cursor, b: Builder): ASTNode {
  // For now, every top-level statement is either a let/print or an expr-stmt.
  if (c.peekKind() === 'LET')   return parseLetStmt(c, b);
  if (c.peekKind() === 'PRINT') return parsePrintStmt(c, b);
  return parseExprStmt(c, b);
}

function parseExprStmt(c: Cursor, b: Builder): ASTNode {
  const expr = parseExpression(c, b);
  c.eat('SEMI');
  return b.addNode(id => ({ id, kind: 'ExprStmt', exprId: expr.id }));
}

// Filled in by Task 9
function parseLetStmt(_c: Cursor, _b: Builder): ASTNode {
  throw new Error('parser: let not yet implemented');
}
function parsePrintStmt(_c: Cursor, _b: Builder): ASTNode {
  throw new Error('parser: print not yet implemented');
}

function parseExpression(c: Cursor, b: Builder, minPrec = 0): ASTNode {
  let left = parsePrimary(c, b);
  while (true) {
    const info = INFIX_PRECEDENCE[c.peekKind()];
    if (!info || info.prec < minPrec) break;
    c.eat(c.peekKind());                              // consume the operator
    const right = parseExpression(c, b, info.prec + 1);  // left-assoc
    const node = b.addNode(id => ({
      id, kind: 'BinOp', op: info.op, leftId: left.id, rightId: right.id,
    }));
    left = node;
  }
  return left;
}

function parsePrimary(c: Cursor, b: Builder): ASTNode {
  const t = c.peek();
  switch (t.kind) {
    case 'INT': {
      c.eat('INT');
      return b.addNode(id => ({ id, kind: 'IntLit', value: t.value! }));
    }
    case 'TRUE':
      c.eat('TRUE');
      return b.addNode(id => ({ id, kind: 'BoolLit', value: true }));
    case 'FALSE':
      c.eat('FALSE');
      return b.addNode(id => ({ id, kind: 'BoolLit', value: false }));
    case 'IDENT': {
      c.eat('IDENT');
      return b.addNode(id => ({ id, kind: 'Var', name: t.text! }));
    }
    case 'PAUSE':
      c.eat('PAUSE');
      return b.addNode(id => ({ id, kind: 'Pause' }));
    case 'LPAREN': {
      c.eat('LPAREN');
      const inner = parseExpression(c, b);
      c.eat('RPAREN');
      return inner;
    }
    default:
      throw new Error(`parser: unexpected token ${t.kind} at line ${t.line} col ${t.col}`);
  }
}
