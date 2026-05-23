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
  // For now, every top-level statement is either a let or an expr-stmt.
  if (c.peekKind() === 'LET') return parseLetStmt(c, b);
  return parseExprStmt(c, b);
}

function parseExprStmt(c: Cursor, b: Builder): ASTNode {
  const expr = parseExpression(c, b);
  c.eat('SEMI');
  return b.addNode(id => ({ id, kind: 'ExprStmt', exprId: expr.id }));
}

function parseLetStmt(c: Cursor, b: Builder): ASTNode {
  c.eat('LET');
  const nameTok = c.eat('IDENT');
  c.eat('EQ');
  const value = parseExpression(c, b);
  c.eat('SEMI');
  return b.addNode(id => ({ id, kind: 'Let', name: nameTok.text!, valueId: value.id }));
}

function parseExpression(c: Cursor, b: Builder, minPrec = 0): ASTNode {
  let left = parsePostfix(c, b);
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

function parsePostfix(c: Cursor, b: Builder): ASTNode {
  let expr = parsePrimary(c, b);
  while (c.peekKind() === 'LPAREN') {
    c.eat('LPAREN');
    const argIds: NodeId[] = [];
    if (c.peekKind() !== 'RPAREN') {
      argIds.push(parseExpression(c, b).id);
      while (c.match('COMMA')) argIds.push(parseExpression(c, b).id);
    }
    c.eat('RPAREN');
    const call = b.addNode(id => ({ id, kind: 'Call', calleeId: expr.id, argIds }));
    expr = call;
  }
  return expr;
}

function parseBlock(c: Cursor, b: Builder): ASTNode {
  c.eat('LBRACE');
  const stmtIds: NodeId[] = [];
  let trailingExprId: NodeId | null = null;

  while (c.peekKind() !== 'RBRACE') {
    // Decide whether the next thing is a statement or the trailing expression.
    // Strategy: let/print are clearly statements; for other things, parse an
    // expression and check what follows.
    if (c.peekKind() === 'LET') {
      stmtIds.push(parseLetStmt(c, b).id);
      continue;
    }
    const expr = parseExpression(c, b);
    if (c.peekKind() === 'SEMI') {
      c.eat('SEMI');
      const stmt = b.addNode(id => ({ id, kind: 'ExprStmt', exprId: expr.id }));
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
  return b.addNode(id => ({ id, kind: 'Block', stmtIds, trailingExprId }));
}

function parseIf(c: Cursor, b: Builder): ASTNode {
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
  }));
}

function parseFn(c: Cursor, b: Builder): ASTNode {
  c.eat('FN');
  c.eat('LPAREN');
  const params: string[] = [];
  if (c.peekKind() !== 'RPAREN') {
    params.push(c.eat('IDENT').text!);
    while (c.match('COMMA')) params.push(c.eat('IDENT').text!);
  }
  c.eat('RPAREN');
  const body = parseBlock(c, b);
  return b.addNode(id => ({ id, kind: 'Fn', params, bodyBlockId: body.id }));
}

function parsePrimary(c: Cursor, b: Builder): ASTNode {
  const t = c.peek();
  switch (t.kind) {
    case 'INT': {
      c.eat('INT');
      return b.addNode(id => ({ id, kind: 'IntLit', value: t.value! }));
    }
    case 'STRING': {
      c.eat('STRING');
      return b.addNode(id => ({ id, kind: 'StringLit', value: t.text! }));
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
    case 'IF':
      return parseIf(c, b);
    case 'FN':
      return parseFn(c, b);
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
