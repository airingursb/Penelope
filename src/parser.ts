// Penelope parser.
// Hand-written recursive descent. Assigns NodeIds deterministically via
// a DFS counter so that re-parsing the same source produces identical IDs
// (essential for snapshot resume).

import type { Token, TokenKind } from './lexer.js';
import type { ASTNode, NodeId, ASTBundle } from './ast.js';

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

function parseStatement(_c: Cursor, _b: Builder): ASTNode {
  throw new Error('parser: statements not yet implemented');
}
