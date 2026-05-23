# Penelope Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tiny TypeScript-on-Node language whose only special primitive is `pause`, and prove that execution can be paused, serialized to a `.penz` JSON file, and resumed in a separate process with full state intact. Phase 1 is complete when three acceptance demos pass: top-level pause, nested-function pause, and fork.

**Architecture:** Hand-written lexer + recursive-descent parser produce an AST. The evaluator is a step machine — a pure function `step(state, ast) → state'` over plain JSON data. `pause` is a single AST node whose step transition signals "stop and save state." `JSON.stringify(state)` IS the snapshot. The CLI orchestrates run/resume/fork/inspect.

**Tech Stack:** TypeScript 5.x, Node.js ≥ 18, Vitest. **Zero production dependencies.**

**Reference spec:** `docs/superpowers/specs/2026-05-22-penelope-phase-1-design.md`

---

## File Structure

| Path | Purpose | Tasks |
|---|---|---|
| `package.json` | Node config; declares `bin/penelope` and `bin/pen` | 0 |
| `tsconfig.json` | TS compiler config, strict mode | 0 |
| `vitest.config.ts` | Test runner config | 0 |
| `.gitignore` | Add `dist/` and `*.penz` exclusions | 0 |
| `src/ast.ts` | Type definitions only | 1 |
| `src/lexer.ts` | `tokenize(source) → Token[]` | 2-5 |
| `src/parser.ts` | `parse(tokens) → ASTBundle` (deterministic NodeIds) | 6-12 |
| `src/interpreter.ts` | `State`, `step(state, ast) → StepResult`, helpers | 13-19 |
| `src/snapshot.ts` | `serialize`, `deserialize` with sha256 verify | 20-21 |
| `src/cli.ts` | argv parsing + subcommand dispatch | 22-25 |
| `bin/penelope` | shebang launcher for `dist/cli.js` | 22 |
| `test/lexer.test.ts` | Lexer unit tests | 2-5 |
| `test/parser.test.ts` | Parser unit tests + determinism | 6-12 |
| `test/interpreter.test.ts` | Step function unit tests | 13-19 |
| `test/snapshot.test.ts` | Roundtrip + verification tests | 20-21 |
| `test/integration.test.ts` | Cross-process acceptance demos | 26-28 |
| `examples/01-toplevel-pause.pen` | Demo 1 source | 26 |
| `examples/02-nested-pause.pen` | Demo 2 source | 27 |
| `examples/03-fork.pen` | Demo 3 source | 28 |
| `README.md` | Append "Phase 1 Status" section | 29 |

Each `src/` module has a single clear responsibility, depends only on `ast.ts` and lower-level modules, and is independently testable.

---

## Task 0: Bootstrap project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Initialize `package.json`**

Create `package.json` with this content:

```json
{
  "name": "penelope",
  "version": "0.0.1",
  "description": "A language that knows how to wait.",
  "private": true,
  "type": "module",
  "bin": {
    "penelope": "./bin/penelope",
    "pen": "./bin/penelope"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.12.0"
  }
}
```

- [ ] **Step 2: Install dev dependencies**

Run: `npm install`
Expected: `node_modules/` populated, `package-lock.json` created. No errors.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 5: Update `.gitignore`**

Add the following lines to the existing `.gitignore` (preserve existing entries):

```
dist/
*.penz
package-lock.json
```

(We gitignore `package-lock.json` because Penelope has zero production deps and we want a clean install story; revisit in Phase 2 if security review demands a lockfile.)

- [ ] **Step 6: Verify the toolchain with a smoke test**

Create `test/smoke.test.ts`:

```ts
import { test, expect } from 'vitest';

test('toolchain works', () => {
  expect(1 + 1).toBe(2);
});
```

Run: `npm test`
Expected: 1 test passing, exit 0.

- [ ] **Step 7: Delete the smoke test (it served its purpose)**

Run: `rm test/smoke.test.ts`

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: bootstrap typescript and vitest"
```

---

## Task 1: Define AST and Value types

**Files:**
- Create: `src/ast.ts`

This task has no tests — `ast.ts` is types-only, validated by `tsc`.

- [ ] **Step 1: Write `src/ast.ts`**

```ts
// Penelope AST and Value types.
// Pure type definitions: no runtime code lives here.

export type NodeId = string;  // e.g., "n0", "n1", ... — assigned deterministically by parser

export type BinOp = '+' | '-' | '*' | '/' | '<' | '>' | '<=' | '>=' | '==' | '!=';

// ============================================================
// AST
// ============================================================

export type ASTNode =
  | { id: NodeId; kind: 'IntLit';   value: number }
  | { id: NodeId; kind: 'BoolLit';  value: boolean }
  | { id: NodeId; kind: 'Var';      name: string }
  | { id: NodeId; kind: 'BinOp';    op: BinOp; leftId: NodeId; rightId: NodeId }
  | { id: NodeId; kind: 'Let';      name: string; valueId: NodeId }
  | { id: NodeId; kind: 'If';       condId: NodeId; thenBlockId: NodeId; elseBlockId: NodeId }
  | { id: NodeId; kind: 'Fn';       params: string[]; bodyBlockId: NodeId }
  | { id: NodeId; kind: 'Call';     calleeId: NodeId; argIds: NodeId[] }
  | { id: NodeId; kind: 'Print';    argId: NodeId }
  | { id: NodeId; kind: 'Pause' }
  | { id: NodeId; kind: 'ExprStmt'; exprId: NodeId }
  | { id: NodeId; kind: 'Block';    stmtIds: NodeId[]; trailingExprId: NodeId | null }
  | { id: NodeId; kind: 'Program';  stmtIds: NodeId[] };

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
  | { tag: 'closure'; paramNames: string[]; bodyBlockId: NodeId; capturedScopeId: ScopeId }
  | { tag: 'unit' };

export type ScopeId = string;  // e.g., "s0", "s1", ...
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/ast.ts
git commit -m "feat(ast): define AST node and value types"
```

---

## Task 2: Lexer — Token type and skeleton

**Files:**
- Create: `src/lexer.ts`, `test/lexer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lexer.test.ts`:

```ts
import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';

test('empty source produces a single EOF token', () => {
  const tokens = tokenize('');
  expect(tokens).toEqual([
    { kind: 'EOF', line: 1, col: 1 },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lexer`
Expected: FAIL — `tokenize` does not exist.

- [ ] **Step 3: Implement the minimal lexer skeleton**

Create `src/lexer.ts`:

```ts
// Penelope lexer.
// `tokenize(source: string)` returns an array of tokens terminated by EOF.

export type TokenKind =
  // literals
  | 'INT' | 'IDENT'
  // keywords
  | 'LET' | 'FN' | 'IF' | 'ELSE' | 'TRUE' | 'FALSE' | 'PAUSE' | 'PRINT'
  // operators
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH'
  | 'LT' | 'GT' | 'LE' | 'GE' | 'EQ_EQ' | 'BANG_EQ'
  | 'EQ'
  // punctuation
  | 'LPAREN' | 'RPAREN' | 'LBRACE' | 'RBRACE' | 'COMMA' | 'SEMI'
  // sentinel
  | 'EOF';

export type Token = {
  kind: TokenKind;
  line: number;
  col: number;
  text?: string;     // for IDENT
  value?: number;    // for INT
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  
  // (we will fill this in across the next few tasks)
  
  tokens.push({ kind: 'EOF', line, col });
  return tokens;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lexer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lexer.ts test/lexer.test.ts
git commit -m "feat(lexer): token types and skeleton with EOF"
```

---

## Task 3: Lexer — integers, identifiers, keywords, booleans

**Files:**
- Modify: `src/lexer.ts`, `test/lexer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/lexer.test.ts`:

```ts
test('tokenizes positive integers', () => {
  const tokens = tokenize('42');
  expect(tokens).toEqual([
    { kind: 'INT', line: 1, col: 1, value: 42 },
    { kind: 'EOF', line: 1, col: 3 },
  ]);
});

test('tokenizes multi-digit integers', () => {
  const tokens = tokenize('100 7');
  expect(tokens[0]).toMatchObject({ kind: 'INT', value: 100 });
  expect(tokens[1]).toMatchObject({ kind: 'INT', value: 7 });
});

test('tokenizes identifiers', () => {
  const tokens = tokenize('foo bar_baz x1');
  expect(tokens[0]).toMatchObject({ kind: 'IDENT', text: 'foo' });
  expect(tokens[1]).toMatchObject({ kind: 'IDENT', text: 'bar_baz' });
  expect(tokens[2]).toMatchObject({ kind: 'IDENT', text: 'x1' });
});

test('tokenizes keywords', () => {
  const src = 'let fn if else true false pause print';
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual(['LET','FN','IF','ELSE','TRUE','FALSE','PAUSE','PRINT','EOF']);
});

test('keywords are not identifiers', () => {
  const tokens = tokenize('let x');
  expect(tokens[0].kind).toBe('LET');
  expect(tokens[1]).toMatchObject({ kind: 'IDENT', text: 'x' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- lexer`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement integers, identifiers, keywords**

Replace the body of `tokenize` in `src/lexer.ts`:

```ts
const KEYWORDS: Record<string, TokenKind> = {
  let:    'LET',
  fn:     'FN',
  if:     'IF',
  else:   'ELSE',
  true:   'TRUE',
  false:  'FALSE',
  pause:  'PAUSE',
  print:  'PRINT',
};

function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isAlpha(c: string): boolean { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isAlphaNum(c: string): boolean { return isAlpha(c) || isDigit(c); }

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  
  const advance = (): string => {
    const c = source[i++];
    if (c === '\n') { line++; col = 1; } else { col++; }
    return c;
  };
  
  while (i < source.length) {
    const c = source[i];
    const startLine = line;
    const startCol = col;
    
    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      advance();
      continue;
    }
    
    // integer literal
    if (isDigit(c)) {
      let text = '';
      while (i < source.length && isDigit(source[i])) text += advance();
      tokens.push({ kind: 'INT', line: startLine, col: startCol, value: Number(text) });
      continue;
    }
    
    // identifier or keyword
    if (isAlpha(c)) {
      let text = '';
      while (i < source.length && isAlphaNum(source[i])) text += advance();
      const kw = KEYWORDS[text];
      if (kw) {
        tokens.push({ kind: kw, line: startLine, col: startCol });
      } else {
        tokens.push({ kind: 'IDENT', line: startLine, col: startCol, text });
      }
      continue;
    }
    
    throw new Error(`lexer: unexpected character '${c}' at line ${line} col ${col}`);
  }
  
  tokens.push({ kind: 'EOF', line, col });
  return tokens;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- lexer`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lexer.ts test/lexer.test.ts
git commit -m "feat(lexer): integers, identifiers, keywords"
```

---

## Task 4: Lexer — operators and punctuation

**Files:**
- Modify: `src/lexer.ts`, `test/lexer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/lexer.test.ts`:

```ts
test('tokenizes single-char operators and punctuation', () => {
  const src = '+ - * / < > = ( ) { } , ;';
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual([
    'PLUS','MINUS','STAR','SLASH','LT','GT','EQ',
    'LPAREN','RPAREN','LBRACE','RBRACE','COMMA','SEMI','EOF',
  ]);
});

test('tokenizes two-char operators', () => {
  const src = '<= >= == !=';
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual(['LE','GE','EQ_EQ','BANG_EQ','EOF']);
});

test('disambiguates < from <=', () => {
  const kinds = tokenize('< <=').map(t => t.kind);
  expect(kinds).toEqual(['LT','LE','EOF']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- lexer`
Expected: FAIL on the new tests.

- [ ] **Step 3: Add operator and punctuation handling**

Modify `tokenize` in `src/lexer.ts`. After the identifier/keyword block and before the `throw`, insert:

```ts
    // two-char operators (peek ahead)
    if (i + 1 < source.length) {
      const two = source[i] + source[i + 1];
      const twoChar: Record<string, TokenKind> = {
        '<=': 'LE', '>=': 'GE', '==': 'EQ_EQ', '!=': 'BANG_EQ',
      };
      if (twoChar[two]) {
        advance(); advance();
        tokens.push({ kind: twoChar[two], line: startLine, col: startCol });
        continue;
      }
    }
    
    // single-char operators and punctuation
    const oneChar: Record<string, TokenKind> = {
      '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH',
      '<': 'LT', '>': 'GT', '=': 'EQ',
      '(': 'LPAREN', ')': 'RPAREN', '{': 'LBRACE', '}': 'RBRACE',
      ',': 'COMMA', ';': 'SEMI',
    };
    if (oneChar[c]) {
      advance();
      tokens.push({ kind: oneChar[c], line: startLine, col: startCol });
      continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- lexer`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lexer.ts test/lexer.test.ts
git commit -m "feat(lexer): operators and punctuation"
```

---

## Task 5: Lexer — line comments

**Files:**
- Modify: `src/lexer.ts`, `test/lexer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/lexer.test.ts`:

```ts
test('skips line comments', () => {
  const src = `// this is a comment
let x = 1;`;
  const kinds = tokenize(src).map(t => t.kind);
  expect(kinds).toEqual(['LET','IDENT','EQ','INT','SEMI','EOF']);
});

test('comment to end of file is OK', () => {
  const src = '42 // trailing comment, no newline';
  const tokens = tokenize(src);
  expect(tokens[0]).toMatchObject({ kind: 'INT', value: 42 });
  expect(tokens[1].kind).toBe('EOF');
});

test('does not treat / not followed by / as a comment', () => {
  expect(tokenize('1 / 2')[1].kind).toBe('SLASH');
});

test('throws on unexpected characters', () => {
  expect(() => tokenize('@')).toThrow(/unexpected character/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- lexer`
Expected: comment-skipping tests FAIL.

- [ ] **Step 3: Add comment handling**

In `src/lexer.ts` `tokenize`, just after the whitespace block, add:

```ts
    // line comment
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- lexer`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lexer.ts test/lexer.test.ts
git commit -m "feat(lexer): line comments"
```

---

## Task 6: Parser — skeleton with deterministic NodeIds

**Files:**
- Create: `src/parser.ts`, `test/parser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/parser.test.ts`:

```ts
import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

test('parses empty program', () => {
  const ast = parse(tokenize(''));
  expect(ast.nodes[ast.rootId]).toMatchObject({ kind: 'Program', stmtIds: [] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- parser`
Expected: FAIL — `parse` does not exist.

- [ ] **Step 3: Implement parser skeleton with NodeId allocator**

Create `src/parser.ts`:

```ts
// Penelope parser.
// Hand-written recursive descent. Assigns NodeIds deterministically via
// a DFS counter so that re-parsing the same source produces identical IDs
// (essential for snapshot resume).

import type { Token, TokenKind } from './lexer.js';
import type { ASTNode, NodeId, ASTBundle, BinOp } from './ast.js';

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- parser`
Expected: PASS (empty program parses).

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts test/parser.test.ts
git commit -m "feat(parser): skeleton with deterministic NodeId allocator"
```

---

## Task 7: Parser — literals, variables, parenthesized expressions

**Files:**
- Modify: `src/parser.ts`, `test/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/parser.test.ts`:

```ts
test('parses an int-literal expression statement', () => {
  const ast = parse(tokenize('42;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'IntLit', value: 42 });
});

test('parses a boolean literal', () => {
  const ast = parse(tokenize('true;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'BoolLit', value: true });
});

test('parses a variable reference', () => {
  const ast = parse(tokenize('x;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'Var', name: 'x' });
});

test('parses pause expression', () => {
  const ast = parse(tokenize('pause;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'Pause' });
});
```

- [ ] **Step 2: Run tests — they will fail (no parseStatement / parseExpression yet)**

Run: `npm test -- parser`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement minimal `parseStatement` and `parsePrimary`/`parseExpression`**

In `src/parser.ts`, replace the placeholder `parseStatement` and add the expression parser:

```ts
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

// (parseLetStmt and parsePrintStmt are filled in by Task 9; provide stubs for now)
function parseLetStmt(_c: Cursor, _b: Builder): ASTNode {
  throw new Error('parser: let not yet implemented');
}
function parsePrintStmt(_c: Cursor, _b: Builder): ASTNode {
  throw new Error('parser: print not yet implemented');
}

function parseExpression(c: Cursor, b: Builder): ASTNode {
  // Placeholder — Task 8 adds binary-operator precedence.
  return parsePrimary(c, b);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- parser`
Expected: All passing tests (including new ones) PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts test/parser.test.ts
git commit -m "feat(parser): literals, variables, pause, parens"
```

---

## Task 8: Parser — binary operators with precedence

**Files:**
- Modify: `src/parser.ts`, `test/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/parser.test.ts`:

```ts
test('parses addition', () => {
  const ast = parse(tokenize('1 + 2;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  const bin = ast.nodes[stmt.exprId];
  expect(bin).toMatchObject({ kind: 'BinOp', op: '+' });
});

test('respects precedence: 1 + 2 * 3', () => {
  const ast = parse(tokenize('1 + 2 * 3;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  const top = ast.nodes[stmt.exprId];
  if (top.kind !== 'BinOp') throw new Error('expected BinOp');
  expect(top.op).toBe('+');
  expect(ast.nodes[top.leftId]).toMatchObject({ kind: 'IntLit', value: 1 });
  const right = ast.nodes[top.rightId];
  if (right.kind !== 'BinOp') throw new Error('expected BinOp on right');
  expect(right.op).toBe('*');
});

test('parses comparison', () => {
  const ast = parse(tokenize('x < 10;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'BinOp', op: '<' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- parser`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement Pratt-style precedence climbing**

In `src/parser.ts`, replace `parseExpression` with this implementation:

```ts
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

function parseExpression(c: Cursor, b: Builder, minPrec = 0): ASTNode {
  let left = parsePrimary(c, b);
  while (true) {
    const info = INFIX_PRECEDENCE[c.peekKind()];
    if (!info || info.prec < minPrec) break;
    c.eat(c.peekKind());                        // consume the operator
    const right = parseExpression(c, b, info.prec + 1);  // left-assoc
    const node = b.addNode(id => ({
      id, kind: 'BinOp', op: info.op, leftId: left.id, rightId: right.id,
    }));
    left = node;
  }
  return left;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- parser`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts test/parser.test.ts
git commit -m "feat(parser): binary operators with precedence"
```

---

## Task 9: Parser — `let` and `print` statements

**Files:**
- Modify: `src/parser.ts`, `test/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/parser.test.ts`:

```ts
test('parses let statement', () => {
  const ast = parse(tokenize('let x = 42;'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'Let') throw new Error('expected Let');
  expect(stmt.name).toBe('x');
  expect(ast.nodes[stmt.valueId]).toMatchObject({ kind: 'IntLit', value: 42 });
});

test('parses print statement', () => {
  const ast = parse(tokenize('print(x + 1);'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'Print') throw new Error('expected Print');
  const arg = ast.nodes[stmt.argId];
  expect(arg.kind).toBe('BinOp');
});

test('parses multiple top-level statements in order', () => {
  const ast = parse(tokenize('let x = 1; print(x);'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  expect(program.stmtIds.length).toBe(2);
  expect(ast.nodes[program.stmtIds[0]].kind).toBe('Let');
  expect(ast.nodes[program.stmtIds[1]].kind).toBe('Print');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- parser`
Expected: FAIL.

- [ ] **Step 3: Implement `parseLetStmt` and `parsePrintStmt`**

Replace the stub implementations in `src/parser.ts`:

```ts
function parseLetStmt(c: Cursor, b: Builder): ASTNode {
  c.eat('LET');
  const nameTok = c.eat('IDENT');
  c.eat('EQ');
  const value = parseExpression(c, b);
  c.eat('SEMI');
  return b.addNode(id => ({ id, kind: 'Let', name: nameTok.text!, valueId: value.id }));
}

function parsePrintStmt(c: Cursor, b: Builder): ASTNode {
  c.eat('PRINT');
  c.eat('LPAREN');
  const arg = parseExpression(c, b);
  c.eat('RPAREN');
  c.eat('SEMI');
  return b.addNode(id => ({ id, kind: 'Print', argId: arg.id }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- parser`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts test/parser.test.ts
git commit -m "feat(parser): let and print statements"
```

---

## Task 10: Parser — function literals, calls, blocks

**Files:**
- Modify: `src/parser.ts`, `test/parser.test.ts`

This is the heart of the parser. A `Block` is `{ stmt* expr? }` — statements (each ending in `;`) followed by an optional trailing expression (no `;`). We parse Blocks anywhere a `{...}` appears: function bodies and (next task) if branches.

- [ ] **Step 1: Write failing tests**

Add to `test/parser.test.ts`:

```ts
test('parses a function literal', () => {
  const ast = parse(tokenize('let f = fn(x, y) { x + y };'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const letStmt = ast.nodes[program.stmtIds[0]];
  if (letStmt.kind !== 'Let') throw new Error('expected Let');
  const fn = ast.nodes[letStmt.valueId];
  if (fn.kind !== 'Fn') throw new Error('expected Fn');
  expect(fn.params).toEqual(['x', 'y']);
  
  const body = ast.nodes[fn.bodyBlockId];
  if (body.kind !== 'Block') throw new Error('expected Block');
  expect(body.stmtIds).toEqual([]);
  expect(body.trailingExprId).not.toBeNull();
});

test('parses a function call', () => {
  const ast = parse(tokenize('f(1, 2);'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  const call = ast.nodes[stmt.exprId];
  if (call.kind !== 'Call') throw new Error('expected Call');
  expect(call.argIds.length).toBe(2);
});

test('parses a block with statements and a trailing expression', () => {
  const ast = parse(tokenize('let f = fn() { let a = 1; a + 2 };'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const letStmt = ast.nodes[program.stmtIds[0]];
  if (letStmt.kind !== 'Let') throw new Error('expected Let');
  const fn = ast.nodes[letStmt.valueId];
  if (fn.kind !== 'Fn') throw new Error('expected Fn');
  const block = ast.nodes[fn.bodyBlockId];
  if (block.kind !== 'Block') throw new Error('expected Block');
  expect(block.stmtIds.length).toBe(1);
  expect(block.trailingExprId).not.toBeNull();
});

test('parses a block with no trailing expression (unit-valued)', () => {
  const ast = parse(tokenize('let f = fn() { let a = 1; };'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const letStmt = ast.nodes[program.stmtIds[0]];
  if (letStmt.kind !== 'Let') throw new Error('expected Let');
  const fn = ast.nodes[letStmt.valueId];
  if (fn.kind !== 'Fn') throw new Error('expected Fn');
  const block = ast.nodes[fn.bodyBlockId];
  if (block.kind !== 'Block') throw new Error('expected Block');
  expect(block.stmtIds.length).toBe(1);
  expect(block.trailingExprId).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- parser`
Expected: FAIL.

- [ ] **Step 3: Implement Fn, Call, Block**

Add to `src/parser.ts`:

```ts
function parseBlock(c: Cursor, b: Builder): ASTNode {
  c.eat('LBRACE');
  const stmtIds: NodeId[] = [];
  let trailingExprId: NodeId | null = null;
  
  while (c.peekKind() !== 'RBRACE') {
    // Decide whether the next thing is a statement or the trailing expression.
    // Strategy: try to parse a "starter" — let/print are clearly statements.
    // For other things, parse an expression, then peek:
    //   if next token is ';' → it was an ExprStmt
    //   if next token is '}' → it's the trailing expression
    if (c.peekKind() === 'LET') {
      stmtIds.push(parseLetStmt(c, b).id);
      continue;
    }
    if (c.peekKind() === 'PRINT') {
      stmtIds.push(parsePrintStmt(c, b).id);
      continue;
    }
    // Otherwise, parse an expression and check what follows.
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
```

Now extend `parsePrimary` to recognize `fn`:

```ts
    case 'FN':
      return parseFn(c, b);
```

(Add this case inside the existing `switch (t.kind)`.)

And add call-expression handling. Calls are postfix — `f(args)`. Add this AFTER `parsePrimary` returns, in `parseExpression`. Modify `parseExpression`:

```ts
function parseExpression(c: Cursor, b: Builder, minPrec = 0): ASTNode {
  let left = parsePostfix(c, b);
  while (true) {
    const info = INFIX_PRECEDENCE[c.peekKind()];
    if (!info || info.prec < minPrec) break;
    c.eat(c.peekKind());
    const right = parseExpression(c, b, info.prec + 1);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- parser`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts test/parser.test.ts
git commit -m "feat(parser): fn literals, call expressions, blocks"
```

---

## Task 11: Parser — `if` expression

**Files:**
- Modify: `src/parser.ts`, `test/parser.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/parser.test.ts`:

```ts
test('parses if/else expression', () => {
  const ast = parse(tokenize('let x = if (true) { 1 } else { 2 };'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const letStmt = ast.nodes[program.stmtIds[0]];
  if (letStmt.kind !== 'Let') throw new Error('expected Let');
  const ifExpr = ast.nodes[letStmt.valueId];
  if (ifExpr.kind !== 'If') throw new Error('expected If');
  expect(ast.nodes[ifExpr.condId]).toMatchObject({ kind: 'BoolLit', value: true });
  expect(ast.nodes[ifExpr.thenBlockId].kind).toBe('Block');
  expect(ast.nodes[ifExpr.elseBlockId].kind).toBe('Block');
});
```

- [ ] **Step 2: Run test — verify failure**

Run: `npm test -- parser`
Expected: FAIL.

- [ ] **Step 3: Implement `if`**

Add `parseIf` to `src/parser.ts`:

```ts
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
```

Extend the `parsePrimary` switch:

```ts
    case 'IF':
      return parseIf(c, b);
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- parser`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts test/parser.test.ts
git commit -m "feat(parser): if/else expression"
```

---

## Task 12: Parser — NodeId determinism guarantee

**Files:**
- Modify: `test/parser.test.ts`

The actual implementation (DFS counter) is already in place. This task adds the determinism test that guards the resume invariant.

- [ ] **Step 1: Write the determinism test**

Add to `test/parser.test.ts`:

```ts
test('parsing the same source twice produces identical NodeId assignments', () => {
  const src = `
    let x = 10;
    let f = fn(a, b) {
      if (a < b) { a + 1 } else { b * 2 }
    };
    print(f(x, 20));
  `;
  const ast1 = parse(tokenize(src));
  const ast2 = parse(tokenize(src));
  
  // Same root id
  expect(ast1.rootId).toBe(ast2.rootId);
  
  // Same set of node ids
  expect(Object.keys(ast1.nodes).sort()).toEqual(Object.keys(ast2.nodes).sort());
  
  // Same content per id
  for (const id of Object.keys(ast1.nodes)) {
    expect(ast1.nodes[id]).toEqual(ast2.nodes[id]);
  }
});

test('parsing different source produces different node id sets', () => {
  const a = parse(tokenize('let x = 1;'));
  const b = parse(tokenize('let x = 1; let y = 2;'));
  expect(Object.keys(a.nodes).length).toBeLessThan(Object.keys(b.nodes).length);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test -- parser`
Expected: All PASS (the determinism is already a property of the DFS counter — these tests just nail it down).

- [ ] **Step 3: Commit**

```bash
git add test/parser.test.ts
git commit -m "test(parser): NodeId determinism guard"
```

---

## Task 13: Interpreter — State types and skeleton

**Files:**
- Create: `src/interpreter.ts`, `test/interpreter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/interpreter.test.ts`:

```ts
import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { runToCompletion } from '../src/interpreter.js';

test('a literal expression-statement program runs to completion', () => {
  const ast = parse(tokenize('42;'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('done');
});
```

- [ ] **Step 2: Run test — verify failure**

Run: `npm test -- interpreter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the interpreter skeleton**

Create `src/interpreter.ts`:

```ts
// Penelope step-machine interpreter.
// step(state, ast): pure function over plain data.
// runToCompletion drives step in a loop until done | paused | error.

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
// Loop driver (used by tests and CLI)
// ============================================================

export function runToCompletion(ast: ASTBundle): StepResult {
  let state = initialState(ast.rootId);
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
      return { kind: 'error', message: `unimplemented op: ${instr.op}` };
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
      return { kind: 'error', message: `unimplemented eval kind: ${node.kind}`, atNode: node.id };
  }
}

function cont(state: State): StepResult {
  return { kind: 'continue', state };
}
```

(The `ExprStmt` case isn't here yet — so the test `42;` will fail because Program contains ExprStmt. Wait — let's adjust the test to not need ExprStmt yet, then add it in the next steps.)

Actually a Program contains ExprStmt → cannot run `42;` end-to-end without ExprStmt. The test must wait. Update the test to evaluate an int literal directly using `runToCompletion`-style API exposed for testing.

- [ ] **Step 3b: Update the test to use `runFromNode` rather than full programs**

Actually, the cleanest approach is to make `runToCompletion` work with a fresh state pointed at any node. Let me expose a test helper and update the test:

Replace `runToCompletion` in `src/interpreter.ts` with a version that accepts an optional starting node:

```ts
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
```

And update the test:

```ts
test('runs an integer literal to completion with the literal on the value stack', () => {
  const ast = parse(tokenize('42;'));
  // Find the IntLit node directly (skip Program/ExprStmt for now).
  const intLit = Object.values(ast.nodes).find(n => n.kind === 'IntLit');
  expect(intLit).toBeDefined();
  const result = runToCompletion(ast, intLit!.id);
  if (result.kind !== 'done') throw new Error(`expected done, got ${result.kind}`);
  expect(result.finalValue).toEqual({ tag: 'int', v: 42 });
});

test('runs a boolean literal', () => {
  const ast = parse(tokenize('true;'));
  const lit = Object.values(ast.nodes).find(n => n.kind === 'BoolLit');
  const result = runToCompletion(ast, lit!.id);
  if (result.kind !== 'done') throw new Error(`expected done`);
  expect(result.finalValue).toEqual({ tag: 'bool', v: true });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- interpreter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "feat(interpreter): state types, skeleton, literal evaluation"
```

---

## Task 14: Interpreter — Var, BinOp, applyBin

**Files:**
- Modify: `src/interpreter.ts`, `test/interpreter.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/interpreter.test.ts`:

```ts
test('evaluates 1 + 2 to 3', () => {
  const ast = parse(tokenize('1 + 2;'));
  const top = Object.values(ast.nodes).find(n => n.kind === 'BinOp');
  const result = runToCompletion(ast, top!.id);
  if (result.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(result)}`);
  expect(result.finalValue).toEqual({ tag: 'int', v: 3 });
});

test('respects precedence: 1 + 2 * 3 = 7', () => {
  const ast = parse(tokenize('1 + 2 * 3;'));
  // The top BinOp is the +; its right is the *.
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error(`expected done`);
  expect(result.finalValue).toEqual({ tag: 'int', v: 7 });
});

test('division truncates toward zero', () => {
  const ast = parse(tokenize('7 / 2;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error(`expected done`);
  expect(result.finalValue).toEqual({ tag: 'int', v: 3 });
});

test('comparison produces bool', () => {
  const ast = parse(tokenize('1 < 2;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error(`expected done`);
  expect(result.finalValue).toEqual({ tag: 'bool', v: true });
});

test('type mismatch on + is a runtime error', () => {
  const ast = parse(tokenize('1 + true;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  expect(result.kind).toBe('error');
});

test('division by zero is a runtime error', () => {
  const ast = parse(tokenize('1 / 0;'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/division by zero/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- interpreter`
Expected: FAIL.

- [ ] **Step 3: Implement Var, BinOp, applyBin**

In `src/interpreter.ts`, extend `stepEval` to handle Var and BinOp:

```ts
function stepEval(state: State, rest: ControlInstr[], node: ASTNode, ast: ASTBundle): StepResult {
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
      return { kind: 'error', message: `unimplemented eval kind: ${node.kind}`, atNode: node.id };
  }
}

function lookup(scopes: Record<ScopeId, Scope>, scopeId: ScopeId, name: string): Value | undefined {
  let cur: ScopeId | null = scopeId;
  while (cur !== null) {
    const sc = scopes[cur];
    if (name in sc.bindings) return sc.bindings[name];
    cur = sc.parentId;
  }
  return undefined;
}
```

Now extend `step` to handle `applyBin`. Replace the switch in `step`:

```ts
  switch (instr.op) {
    case 'eval':
      return stepEval(state, rest, ast.nodes[instr.nodeId], ast);
    case 'applyBin':
      return applyBinOp(state, rest, instr.binOp);
    default:
      return { kind: 'error', message: `unimplemented op: ${instr.op}` };
  }
```

Add the helper:

```ts
function applyBinOp(state: State, rest: ControlInstr[], op: BinOp): StepResult {
  const stack = state.valueStack;
  const right = stack[stack.length - 1];
  const left  = stack[stack.length - 2];
  const newStack = stack.slice(0, -2);
  
  // Integer arithmetic and comparisons require both ints.
  if (op === '+' || op === '-' || op === '*' || op === '/') {
    if (left.tag !== 'int' || right.tag !== 'int')
      return { kind: 'error', message: `cannot apply '${op}' to ${left.tag} and ${right.tag}` };
    let result: number;
    if (op === '+') result = left.v + right.v;
    else if (op === '-') result = left.v - right.v;
    else if (op === '*') result = left.v * right.v;
    else /* / */ {
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
  
  // == and != work on int or bool (must match tags)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- interpreter`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "feat(interpreter): Var, BinOp, scope lookup, applyBin"
```

---

## Task 15: Interpreter — Program, Let, ExprStmt, Print

**Files:**
- Modify: `src/interpreter.ts`, `test/interpreter.test.ts`

After this task, the simplest programs (top-level let + print) can run end-to-end.

- [ ] **Step 1: Write failing tests**

Add to `test/interpreter.test.ts`:

```ts
test('let + arithmetic + reference works', () => {
  const ast = parse(tokenize('let x = 10; let y = 5; x + y;'));
  const stmt = Object.values(ast.nodes).filter(n => n.kind === 'ExprStmt')[0];
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  // We need to run the whole program, then peek at the global binding...
  // ... but ExprStmt discards. Better: just test that the whole program runs without error.
  const result = runToCompletion(ast);
  expect(result.kind).toBe('done');
});

test('print writes to stdout (captured via spy)', () => {
  const ast = parse(tokenize('print(1 + 2);'));
  // Capture console.log
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['3']);
  } finally {
    console.log = origLog;
  }
});

test('undefined variable is a runtime error', () => {
  const ast = parse(tokenize('x;'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/undefined variable 'x'/);
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `npm test -- interpreter`
Expected: FAIL (Program/Let/ExprStmt/Print not yet handled).

- [ ] **Step 3: Extend `stepEval`**

In `src/interpreter.ts`, add cases inside `stepEval`'s switch:

```ts
    case 'Program':
      return cont({ ...state, control: [
        ...rest,
        ...[...node.stmtIds].reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
      ]});
    
    case 'ExprStmt':
      return cont({ ...state, control: [
        ...rest,
        { op: 'discard' },
        { op: 'eval', nodeId: node.exprId },
      ]});
    
    case 'Let':
      return cont({ ...state, control: [
        ...rest,
        { op: 'bindLet', name: node.name },
        { op: 'eval', nodeId: node.valueId },
      ]});
    
    case 'Print':
      return cont({ ...state, control: [
        ...rest,
        { op: 'applyPrint' },
        { op: 'eval', nodeId: node.argId },
      ]});
```

Now extend `step`'s switch to handle the new ControlInstr ops:

```ts
  switch (instr.op) {
    case 'eval':
      return stepEval(state, rest, ast.nodes[instr.nodeId], ast);
    case 'applyBin':
      return applyBinOp(state, rest, instr.binOp);
    case 'applyPrint': {
      const v = state.valueStack[state.valueStack.length - 1];
      console.log(formatValue(v));
      return cont({ ...state, control: rest,
        valueStack: state.valueStack.slice(0, -1) });
    }
    case 'bindLet': {
      const v = state.valueStack[state.valueStack.length - 1];
      const scope = state.scopes[state.currentScopeId];
      return cont({ ...state, control: rest,
        valueStack: state.valueStack.slice(0, -1),
        scopes: { ...state.scopes,
          [state.currentScopeId]: { ...scope,
            bindings: { ...scope.bindings, [instr.name]: v }}}});
    }
    case 'discard':
      return cont({ ...state, control: rest,
        valueStack: state.valueStack.slice(0, -1) });
    default:
      return { kind: 'error', message: `unimplemented op: ${instr.op}` };
  }
```

Add `formatValue` to `src/interpreter.ts`:

```ts
export function formatValue(v: Value): string {
  switch (v.tag) {
    case 'int':     return String(v.v);
    case 'bool':    return v.v ? 'true' : 'false';
    case 'unit':    return '()';
    case 'closure': return '<fn>';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- interpreter`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "feat(interpreter): Program, Let, ExprStmt, Print, applyPrint, bindLet, discard"
```

---

## Task 16: Interpreter — Block (push/pop scope, pushUnit)

**Files:**
- Modify: `src/interpreter.ts`, `test/interpreter.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/interpreter.test.ts`:

```ts
test('a fn body block evaluates to its trailing expression', () => {
  // Use a block directly via if (since fn requires Call to invoke; that's Task 17)
  // Skip — focus on Block via if's branches.
  const ast = parse(tokenize('print(if (true) { 1 + 2 } else { 99 });'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['3']);
  } finally {
    console.log = origLog;
  }
});

test('a block with no trailing expression evaluates to unit', () => {
  const ast = parse(tokenize('print(if (true) { } else { });'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['()']);
  } finally {
    console.log = origLog;
  }
});

test('block scope isolates lets', () => {
  // `let x = 1;` inside a block is not visible outside.
  const ast = parse(tokenize(`
    print(if (true) { let x = 99; x } else { 0 });
  `));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['99']);
  } finally {
    console.log = origLog;
  }
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `npm test -- interpreter`
Expected: FAIL — Block and If not yet handled.

- [ ] **Step 3: Implement Block, If, pushUnit, popScope, branch**

Extend `stepEval`'s switch:

```ts
    case 'Block': {
      const newScopeId = `s${state.nextScopeIdCounter}`;
      const trailing: ControlInstr = node.trailingExprId !== null
        ? { op: 'eval', nodeId: node.trailingExprId }
        : { op: 'pushUnit' };
      return cont({
        ...state,
        control: [
          ...rest,
          { op: 'popScope', restoreScopeId: state.currentScopeId },
          trailing,
          ...[...node.stmtIds].reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
        ],
        scopes: { ...state.scopes,
          [newScopeId]: { parentId: state.currentScopeId, bindings: {} }},
        currentScopeId: newScopeId,
        nextScopeIdCounter: state.nextScopeIdCounter + 1,
      });
    }
    
    case 'If':
      return cont({ ...state, control: [
        ...rest,
        { op: 'branch', thenBlockId: node.thenBlockId, elseBlockId: node.elseBlockId },
        { op: 'eval', nodeId: node.condId },
      ]});
```

Extend `step`'s switch:

```ts
    case 'popScope':
      return cont({ ...state, control: rest, currentScopeId: instr.restoreScopeId });
    
    case 'pushUnit':
      return cont({ ...state, control: rest,
        valueStack: [...state.valueStack, { tag: 'unit' }] });
    
    case 'branch': {
      const cond = state.valueStack[state.valueStack.length - 1];
      if (cond.tag !== 'bool')
        return { kind: 'error', message: `if condition must be bool, got ${cond.tag}` };
      return cont({ ...state, control: [
        ...rest,
        { op: 'eval', nodeId: cond.v ? instr.thenBlockId : instr.elseBlockId },
      ], valueStack: state.valueStack.slice(0, -1) });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- interpreter`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "feat(interpreter): Block, If, branch, popScope, pushUnit"
```

---

## Task 17: Interpreter — Fn, Call, invoke

**Files:**
- Modify: `src/interpreter.ts`, `test/interpreter.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/interpreter.test.ts`:

```ts
test('fn definition and call', () => {
  const ast = parse(tokenize(`
    let add = fn(a, b) { a + b };
    print(add(2, 3));
  `));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['5']);
  } finally {
    console.log = origLog;
  }
});

test('lexical closure captures outer scope', () => {
  const ast = parse(tokenize(`
    let outer = fn() {
      let a = 100;
      let inner = fn() { a + 1 };
      inner()
    };
    print(outer());
  `));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['101']);
  } finally {
    console.log = origLog;
  }
});

test('arg-count mismatch is a runtime error', () => {
  const ast = parse(tokenize('let f = fn(a) { a }; f(1, 2);'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/expected 1 args, got 2/);
});

test('calling a non-function is a runtime error', () => {
  const ast = parse(tokenize('let x = 1; x(5);'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/not callable/);
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `npm test -- interpreter`
Expected: FAIL.

- [ ] **Step 3: Implement Fn (creates closure), Call (queues invoke), invoke**

Extend `stepEval`'s switch:

```ts
    case 'Fn': {
      const closure: Value = {
        tag: 'closure',
        paramNames: node.params,
        bodyBlockId: node.bodyBlockId,
        capturedScopeId: state.currentScopeId,
      };
      return cont({ ...state, control: rest,
        valueStack: [...state.valueStack, closure] });
    }
    
    case 'Call':
      // Evaluate callee, then args left-to-right, then invoke.
      return cont({ ...state, control: [
        ...rest,
        { op: 'invoke', argCount: node.argIds.length },
        ...[...node.argIds].reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
        { op: 'eval', nodeId: node.calleeId },
      ]});
```

Extend `step`'s switch:

```ts
    case 'invoke':
      return invokeClosure(state, rest, instr.argCount);
```

Add helper:

```ts
function invokeClosure(state: State, rest: ControlInstr[], argCount: number): StepResult {
  const stack = state.valueStack;
  const args = stack.slice(stack.length - argCount);
  const closure = stack[stack.length - argCount - 1];
  
  if (closure.tag !== 'closure')
    return { kind: 'error', message: `not callable: ${formatValue(closure)}` };
  if (closure.paramNames.length !== argCount)
    return { kind: 'error', message: `expected ${closure.paramNames.length} args, got ${argCount}` };
  
  const newScopeId = `s${state.nextScopeIdCounter}`;
  const bindings: Record<string, Value> = {};
  for (let i = 0; i < argCount; i++) bindings[closure.paramNames[i]] = args[i];
  
  return cont({
    ...state,
    control: [
      ...rest,
      { op: 'popScope', restoreScopeId: state.currentScopeId },
      { op: 'eval', nodeId: closure.bodyBlockId },
    ],
    valueStack: stack.slice(0, stack.length - argCount - 1),
    scopes: { ...state.scopes,
      [newScopeId]: { parentId: closure.capturedScopeId, bindings }},
    currentScopeId: newScopeId,
    nextScopeIdCounter: state.nextScopeIdCounter + 1,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- interpreter`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "feat(interpreter): Fn closures, Call, invoke"
```

---

## Task 18: Interpreter — Pause

**Files:**
- Modify: `src/interpreter.ts`, `test/interpreter.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/interpreter.test.ts`:

```ts
test('pause halts the loop with a snapshot', () => {
  const ast = parse(tokenize('let x = pause; x + 1;'));
  const result = runToCompletion(ast);
  expect(result.kind).toBe('paused');
  if (result.kind === 'paused') {
    expect(typeof result.pausedAt).toBe('string');
    // After pause, the bindLet for x is still pending on control.
    expect(result.state.control.length).toBeGreaterThan(0);
  }
});

test('resume by pushing a value to valueStack and continuing', () => {
  const ast = parse(tokenize('let x = pause; print(x + 1);'));
  const paused = runToCompletion(ast);
  if (paused.kind !== 'paused') throw new Error(`expected paused`);
  
  // Inject the resume value
  const resumedState = {
    ...paused.state,
    valueStack: [...paused.state.valueStack, { tag: 'int' as const, v: 41 }],
  };
  
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    let s = resumedState;
    while (true) {
      const r = step(s, ast);
      if (r.kind === 'continue') { s = r.state; continue; }
      expect(r.kind).toBe('done');
      break;
    }
    expect(logged).toEqual(['42']);
  } finally {
    console.log = origLog;
  }
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `npm test -- interpreter`
Expected: FAIL.

- [ ] **Step 3: Implement Pause**

Extend `stepEval`'s switch in `src/interpreter.ts`:

```ts
    case 'Pause':
      return { kind: 'paused',
               state: { ...state, control: rest },
               pausedAt: node.id };
```

(That's it — Pause is the simplest case in the entire evaluator.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- interpreter`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "feat(interpreter): pause primitive"
```

---

## Task 19: Snapshot — serialize + sha256

**Files:**
- Create: `src/snapshot.ts`, `test/snapshot.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/snapshot.test.ts`:

```ts
import { test, expect } from 'vitest';
import { sha256, serialize } from '../src/snapshot.js';
import type { Snapshot } from '../src/snapshot.js';

test('sha256 produces a deterministic hex digest', () => {
  expect(sha256('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('serialize produces valid pretty-printed JSON', () => {
  const snap: Snapshot = {
    version: 1,
    programPath: 'x.pen',
    programHash: 'sha256:deadbeef',
    pausedAt: 'n5',
    pausedAtMs: 1234567890,
    state: {
      control: [{ op: 'pushUnit' }],
      valueStack: [],
      scopes: { s0: { parentId: null, bindings: {} } },
      currentScopeId: 's0',
      nextScopeIdCounter: 1,
    },
  };
  const json = serialize(snap);
  // Round-trip
  expect(JSON.parse(json)).toEqual(snap);
  // Pretty-printed (has newlines)
  expect(json).toContain('\n');
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `npm test -- snapshot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/snapshot.ts`**

Create `src/snapshot.ts`:

```ts
// Penelope snapshot format: JSON.
// Self-contained except for the source file, which is referenced by path+hash.

import { createHash } from 'node:crypto';
import type { NodeId } from './ast.js';
import type { State } from './interpreter.js';

export type Snapshot = {
  version: 1;
  programPath: string;
  programHash: string;        // "sha256:<hex>"
  pausedAt: NodeId;
  pausedAtMs: number;
  state: State;
};

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function serialize(snap: Snapshot): string {
  return JSON.stringify(snap, null, 2);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- snapshot`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts test/snapshot.test.ts
git commit -m "feat(snapshot): sha256 + JSON serialize"
```

---

## Task 20: Snapshot — deserialize with hash verification

**Files:**
- Modify: `src/snapshot.ts`, `test/snapshot.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/snapshot.test.ts`:

```ts
import { deserialize } from '../src/snapshot.js';

const goodSource = 'let x = 1;';
const goodSnap = {
  version: 1 as const,
  programPath: 'x.pen',
  programHash: 'sha256:' + sha256(goodSource),
  pausedAt: 'n5',
  pausedAtMs: 0,
  state: {
    control: [],
    valueStack: [],
    scopes: { s0: { parentId: null, bindings: {} } },
    currentScopeId: 's0',
    nextScopeIdCounter: 1,
  },
};

test('deserialize accepts a matching source', () => {
  const r = deserialize(serialize(goodSnap), () => goodSource);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap.pausedAt).toBe('n5');
  expect(r.source).toBe(goodSource);
});

test('deserialize rejects on hash mismatch', () => {
  const r = deserialize(serialize(goodSnap), () => 'let x = 2;');
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/source has changed/);
});

test('deserialize bypasses hash check with --force', () => {
  const r = deserialize(serialize(goodSnap), () => 'let x = 2;', { force: true });
  expect('snap' in r).toBe(true);
});

test('deserialize reports corrupt JSON', () => {
  const r = deserialize('{not json', () => goodSource);
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/corrupted/);
});

test('deserialize rejects unknown version', () => {
  const bad = { ...goodSnap, version: 999 };
  const r = deserialize(JSON.stringify(bad), () => goodSource);
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/unknown snapshot version/);
});

test('deserialize reports missing source file', () => {
  const r = deserialize(serialize(goodSnap), () => { throw new Error('ENOENT'); });
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/cannot find source file/);
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `npm test -- snapshot`
Expected: FAIL.

- [ ] **Step 3: Implement `deserialize`**

Add to `src/snapshot.ts`:

```ts
export type DeserializeResult =
  | { snap: Snapshot; source: string }
  | { error: string };

export type DeserializeOptions = {
  force?: boolean;  // skip hash check
};

export function deserialize(
  json: string,
  resolveSource: (programPath: string) => string,
  options: DeserializeOptions = {},
): DeserializeResult {
  let snap: Snapshot;
  try {
    snap = JSON.parse(json);
  } catch {
    return { error: 'snapshot is corrupted (invalid JSON)' };
  }
  
  if (snap.version !== 1) {
    return { error: `unknown snapshot version: ${snap.version}` };
  }
  
  let source: string;
  try {
    source = resolveSource(snap.programPath);
  } catch {
    return { error: `cannot find source file: ${snap.programPath}. Use --source to override.` };
  }
  
  const actualHash = 'sha256:' + sha256(source);
  if (actualHash !== snap.programHash && !options.force) {
    return { error: `source has changed since pause (expected ${snap.programHash}, got ${actualHash}). Use --force to override.` };
  }
  
  return { snap, source };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- snapshot`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts test/snapshot.test.ts
git commit -m "feat(snapshot): deserialize with hash verification"
```

---

## Task 21: CLI — argv parser + `run` subcommand

**Files:**
- Create: `src/cli.ts`, `bin/penelope`

For Phase 1 the CLI doesn't get its own unit tests — its behavior is exercised through the integration tests in Tasks 26-28. (CLI logic is thin orchestration; the real testing is end-to-end.)

- [ ] **Step 1: Create the launcher script**

Create `bin/penelope`:

```sh
#!/bin/sh
# Penelope launcher. Forwards to the compiled CLI.
DIR="$(dirname "$0")"
exec node "$DIR/../dist/cli.js" "$@"
```

Run: `chmod +x bin/penelope`

- [ ] **Step 2: Implement `src/cli.ts` with argv parsing and `run` subcommand**

Create `src/cli.ts`:

```ts
// Penelope CLI.
// Subcommands: run, resume, fork, inspect.
// Argv parsing is hand-rolled — Phase 1 has zero dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { initialState, step, formatValue } from './interpreter.js';
import type { State, StepResult } from './interpreter.js';
import { serialize, deserialize, sha256 } from './snapshot.js';
import type { Snapshot } from './snapshot.js';
import type { ASTBundle, Value } from './ast.js';

// ============================================================
// Argv parsing
// ============================================================

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | true>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ============================================================
// Helpers
// ============================================================

function defaultSnapshotPath(sourcePath: string): string {
  const dir = dirname(sourcePath);
  const base = basename(sourcePath).replace(/\.pen$/, '');
  return join(dir, `${base}.penz`);
}

function loop(state: State, ast: ASTBundle): StepResult {
  let s = state;
  while (true) {
    const r = step(s, ast);
    if (r.kind === 'continue') { s = r.state; continue; }
    return r;
  }
}

// ============================================================
// run subcommand
// ============================================================

function cmdRun(args: ParsedArgs): number {
  const sourcePath = args.positional[1];   // [0] is "run"
  if (!sourcePath) {
    process.stderr.write('usage: penelope run <file.pen>\n');
    return 2;
  }
  
  const absSourcePath = resolve(sourcePath);
  let source: string;
  try {
    source = readFileSync(absSourcePath, 'utf8');
  } catch {
    process.stderr.write(`cli error: cannot read source file: ${sourcePath}\n`);
    return 3;
  }
  
  let ast: ASTBundle;
  try {
    ast = parse(tokenize(source));
  } catch (e) {
    process.stderr.write(`parse error: ${(e as Error).message}\n`);
    return 1;
  }
  
  const result = loop(initialState(ast.rootId), ast);
  
  if (result.kind === 'done') {
    return 0;
  }
  if (result.kind === 'error') {
    const at = result.atNode ? ` at ${result.atNode}` : '';
    process.stderr.write(`runtime error${at}: ${result.message}\n`);
    return 1;
  }
  if (result.kind === 'paused') {
    const outPath = typeof args.flags.out === 'string'
      ? args.flags.out
      : defaultSnapshotPath(absSourcePath);
    
    const snap: Snapshot = {
      version: 1,
      programPath: basename(absSourcePath),
      programHash: 'sha256:' + sha256(source),
      pausedAt: result.pausedAt,
      pausedAtMs: Date.now(),
      state: result.state,
    };
    writeFileSync(outPath, serialize(snap));
    if (!args.flags.quiet) {
      process.stderr.write(`paused at ${result.pausedAt}; snapshot → ${outPath}\n`);
    }
    return 0;
  }
  return 1;
}

// ============================================================
// Main
// ============================================================

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const sub = args.positional[0];
  if (sub === 'run')     return cmdRun(args);
  process.stderr.write(`usage: penelope <run|resume|fork|inspect> [args]\n`);
  return 2;
}

// Self-invoke when run as a script (the bin/penelope launcher does node dist/cli.js).
process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `dist/cli.js` and related files produced. No tsc errors.

- [ ] **Step 4: Smoke-test `run` manually**

Create a temporary file `/tmp/penelope-smoke.pen` with content `print(1 + 2);`.

Run: `./bin/penelope run /tmp/penelope-smoke.pen`
Expected stdout: `3`, exit code 0.

Run: `echo $?` to confirm exit code.

Clean up: `rm /tmp/penelope-smoke.pen`

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts bin/penelope
git commit -m "feat(cli): argv parser and run subcommand"
```

---

## Task 22: CLI — `resume` subcommand

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add resume value parser and the subcommand**

Add to `src/cli.ts`:

```ts
function parseResumeValue(text: string): Value | { error: string } {
  if (/^-?\d+$/.test(text))   return { tag: 'int', v: Number(text) };
  if (text === 'true')        return { tag: 'bool', v: true };
  if (text === 'false')       return { tag: 'bool', v: false };
  return { error: `cannot parse '${text}' as int or bool` };
}

function cmdResume(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  const valueText = args.positional[2];
  if (!snapPath || valueText === undefined) {
    process.stderr.write('usage: penelope resume <file.penz> <value> [--source <path>] [--force] [--out <path>]\n');
    return 2;
  }
  
  const absSnapPath = resolve(snapPath);
  let snapJson: string;
  try {
    snapJson = readFileSync(absSnapPath, 'utf8');
  } catch {
    process.stderr.write(`cli error: cannot read snapshot: ${snapPath}\n`);
    return 3;
  }
  
  const sourceOverride = typeof args.flags.source === 'string' ? args.flags.source : null;
  const resolveSource = (programPath: string): string => {
    const sourcePath = sourceOverride
      ? resolve(sourceOverride)
      : resolve(dirname(absSnapPath), programPath);
    return readFileSync(sourcePath, 'utf8');
  };
  
  const dr = deserialize(snapJson, resolveSource, { force: !!args.flags.force });
  if ('error' in dr) {
    process.stderr.write(`cli error: ${dr.error}\n`);
    return 3;
  }
  
  const v = parseResumeValue(valueText);
  if ('error' in v) {
    process.stderr.write(`cli error: ${v.error}\n`);
    return 2;
  }
  
  const ast = parse(tokenize(dr.source));
  
  // Inject resume value onto valueStack, then continue stepping.
  const resumedState: State = {
    ...dr.snap.state,
    valueStack: [...dr.snap.state.valueStack, v],
  };
  const result = loop(resumedState, ast);
  
  if (result.kind === 'done') return 0;
  if (result.kind === 'error') {
    process.stderr.write(`runtime error: ${result.message}\n`);
    return 1;
  }
  if (result.kind === 'paused') {
    const outPath = typeof args.flags.out === 'string'
      ? args.flags.out
      : absSnapPath;          // default: overwrite input
    const newSnap: Snapshot = {
      version: 1,
      programPath: dr.snap.programPath,
      programHash: dr.snap.programHash,
      pausedAt: result.pausedAt,
      pausedAtMs: Date.now(),
      state: result.state,
    };
    writeFileSync(outPath, serialize(newSnap));
    if (!args.flags.quiet) {
      process.stderr.write(`paused again at ${result.pausedAt}; snapshot → ${outPath}\n`);
    }
    return 0;
  }
  return 1;
}
```

Wire into `main`:

```ts
  if (sub === 'run')     return cmdRun(args);
  if (sub === 'resume')  return cmdResume(args);
```

- [ ] **Step 2: Build and smoke-test**

Run: `npm run build`

Create `/tmp/p.pen` with `let x = 10; let y = pause; print(x + y);`.

Run sequence:
```bash
./bin/penelope run /tmp/p.pen          # writes /tmp/p.penz
./bin/penelope resume /tmp/p.penz 5    # prints 15
```

Expected: second command prints `15`, exit 0.

Clean up: `rm /tmp/p.pen /tmp/p.penz`

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): resume subcommand with value injection"
```

---

## Task 23: CLI — `fork` subcommand

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add `cmdFork`**

Add to `src/cli.ts`:

```ts
function cmdFork(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  const v1text = args.positional[2];
  const v2text = args.positional[3];
  if (!snapPath || v1text === undefined || v2text === undefined) {
    process.stderr.write('usage: penelope fork <file.penz> <v1> <v2> [--out1 <path>] [--out2 <path>]\n');
    return 2;
  }
  
  const absSnapPath = resolve(snapPath);
  let snapJson: string;
  try { snapJson = readFileSync(absSnapPath, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read snapshot: ${snapPath}\n`); return 3; }
  
  const resolveSource = (programPath: string): string =>
    readFileSync(resolve(dirname(absSnapPath), programPath), 'utf8');
  
  const dr = deserialize(snapJson, resolveSource, { force: !!args.flags.force });
  if ('error' in dr) { process.stderr.write(`cli error: ${dr.error}\n`); return 3; }
  
  const v1 = parseResumeValue(v1text);
  if ('error' in v1) { process.stderr.write(`cli error: ${v1.error}\n`); return 2; }
  const v2 = parseResumeValue(v2text);
  if ('error' in v2) { process.stderr.write(`cli error: ${v2.error}\n`); return 2; }
  
  const ast = parse(tokenize(dr.source));
  
  const baseDir = dirname(absSnapPath);
  const baseName = basename(absSnapPath).replace(/\.penz$/, '');
  const out1 = typeof args.flags.out1 === 'string'
    ? args.flags.out1
    : join(baseDir, `${baseName}.fork0.penz`);
  const out2 = typeof args.flags.out2 === 'string'
    ? args.flags.out2
    : join(baseDir, `${baseName}.fork1.penz`);
  
  // Run each fork with its own console.log prefix.
  const runFork = (label: string, injected: Value, outPath: string): number => {
    const origLog = console.log;
    console.log = (msg: string) => origLog(`[${label}] ${msg}`);
    try {
      const state: State = {
        ...JSON.parse(JSON.stringify(dr.snap.state)),  // deep clone
        valueStack: [...dr.snap.state.valueStack, injected],
      };
      const result = loop(state, ast);
      if (result.kind === 'error') {
        process.stderr.write(`[${label}] runtime error: ${result.message}\n`);
        return 1;
      }
      if (result.kind === 'paused') {
        const newSnap: Snapshot = {
          version: 1,
          programPath: dr.snap.programPath,
          programHash: dr.snap.programHash,
          pausedAt: result.pausedAt,
          pausedAtMs: Date.now(),
          state: result.state,
        };
        writeFileSync(outPath, serialize(newSnap));
        if (!args.flags.quiet) {
          process.stderr.write(`[${label}] paused again; snapshot → ${outPath}\n`);
        }
      }
      return 0;
    } finally {
      console.log = origLog;
    }
  };
  
  const c1 = runFork('fork-0', v1, out1);
  const c2 = runFork('fork-1', v2, out2);
  return (c1 === 0 && c2 === 0) ? 0 : 1;
}
```

Wire into `main`:

```ts
  if (sub === 'fork')    return cmdFork(args);
```

- [ ] **Step 2: Build and commit**

Run: `npm run build`
Expected: clean build.

```bash
git add src/cli.ts
git commit -m "feat(cli): fork subcommand"
```

(Smoke test deferred to integration test Task 28.)

---

## Task 24: CLI — `inspect` subcommand

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add `cmdInspect`**

Add to `src/cli.ts`:

```ts
function cmdInspect(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  if (!snapPath) {
    process.stderr.write('usage: penelope inspect <file.penz>\n');
    return 2;
  }
  
  const absSnapPath = resolve(snapPath);
  let snapJson: string;
  try { snapJson = readFileSync(absSnapPath, 'utf8'); }
  catch { process.stderr.write(`cli error: cannot read snapshot: ${snapPath}\n`); return 3; }
  
  let snap: Snapshot;
  try { snap = JSON.parse(snapJson); }
  catch { process.stderr.write(`cli error: snapshot is corrupted (invalid JSON)\n`); return 3; }
  
  // Try to read source for hash status (non-fatal if it fails)
  let sourceStatus = '? source missing';
  try {
    const source = readFileSync(resolve(dirname(absSnapPath), snap.programPath), 'utf8');
    const actual = 'sha256:' + sha256(source);
    sourceStatus = (actual === snap.programHash) ? '✓ source matches' : '✗ source stale';
  } catch { /* keep sourceStatus as missing */ }
  
  const ageMs = Date.now() - snap.pausedAtMs;
  const ageSec = Math.floor(ageMs / 1000);
  const ageStr = ageSec < 60 ? `${ageSec}s ago`
    : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago`
    : `${Math.floor(ageSec / 3600)}h ago`;
  
  const out = process.stdout;
  out.write(`Snapshot: ${basename(absSnapPath)}\n`);
  out.write(`  Source: ${snap.programPath}  ${sourceStatus}\n`);
  out.write(`  Full path: ${resolve(dirname(absSnapPath), snap.programPath)}\n`);
  out.write(`  Paused at: ${snap.pausedAt}\n`);
  out.write(`  Time: ${new Date(snap.pausedAtMs).toISOString()} (${ageStr})\n`);
  out.write(`\n`);
  out.write(`Scopes:\n`);
  for (const [sid, sc] of Object.entries(snap.state.scopes)) {
    const parent = sc.parentId ? ` ← ${sc.parentId}` : '';
    const binds = Object.entries(sc.bindings).map(([n, v]) => `${n}=${formatValue(v)}`).join(', ');
    out.write(`  ${sid}${parent}: { ${binds} }\n`);
  }
  out.write(`Current scope: ${snap.state.currentScopeId}\n`);
  out.write(`\n`);
  out.write(`Control stack (top → bottom, ${snap.state.control.length} instr):\n`);
  for (let i = snap.state.control.length - 1; i >= 0; i--) {
    out.write(`  ${snap.state.control.length - i}. ${JSON.stringify(snap.state.control[i])}\n`);
  }
  out.write(`\n`);
  out.write(`Value stack (${snap.state.valueStack.length}): `);
  out.write(snap.state.valueStack.map(formatValue).join(', ') || '(empty)');
  out.write(`\n`);
  return 0;
}
```

Wire into `main`:

```ts
  if (sub === 'inspect') return cmdInspect(args);
```

- [ ] **Step 2: Build and commit**

Run: `npm run build`

```bash
git add src/cli.ts
git commit -m "feat(cli): inspect subcommand"
```

---

## Task 25: Examples — write the three `.pen` demo files

**Files:**
- Create: `examples/01-toplevel-pause.pen`, `examples/02-nested-pause.pen`, `examples/03-fork.pen`

- [ ] **Step 1: Write `examples/01-toplevel-pause.pen`**

```pen
let x = 10;
let y = pause;
print(x + y);
```

- [ ] **Step 2: Write `examples/02-nested-pause.pen`**

```pen
let outer = fn() {
  let a = 1;
  let inner = fn() {
    let b = pause;
    a + b
  };
  inner()
};
print(outer());
```

- [ ] **Step 3: Write `examples/03-fork.pen`**

```pen
let base = 100;
let x = pause;
print(base + x);
```

- [ ] **Step 4: Build and manually run each through the CLI**

```bash
npm run build
./bin/penelope run examples/01-toplevel-pause.pen
./bin/penelope resume examples/01-toplevel-pause.penz 5    # expect: 15
rm examples/01-toplevel-pause.penz
```

Repeat for demos 2 and 3 to confirm they work end-to-end.

- [ ] **Step 5: Commit**

```bash
git add examples/
git commit -m "feat(examples): three Phase 1 acceptance demo .pen files"
```

---

## Task 26: Integration — demo 1 (top-level pause)

**Files:**
- Create: `test/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/integration.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const PEN = resolve('bin/penelope');

function cleanup(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

test('demo 1: top-level pause survives across processes', () => {
  const source = resolve('examples/01-toplevel-pause.pen');
  const snap = resolve('examples/01-toplevel-pause.penz');
  cleanup(snap);
  
  // First process: run, hit pause, write snapshot.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);
  
  // Second process: resume with y = 5, expect 15.
  const r2 = spawnSync(PEN, ['resume', snap, '5'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('15');
  
  cleanup(snap);
});
```

- [ ] **Step 2: Make sure `dist/` is built**

Run: `npm run build`

- [ ] **Step 3: Run the integration test**

Run: `npm test -- integration`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): demo 1 — top-level pause across processes"
```

---

## Task 27: Integration — demo 2 (nested-function pause)

**Files:**
- Modify: `test/integration.test.ts`

- [ ] **Step 1: Append the demo 2 test**

Add to `test/integration.test.ts`:

```ts
test('demo 2: nested-function pause preserves the enclosing call frame', () => {
  const source = resolve('examples/02-nested-pause.pen');
  const snap = resolve('examples/02-nested-pause.penz');
  cleanup(snap);
  
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);
  
  // Resume with b = 41; outer should print 42 (a=1 + b=41).
  const r2 = spawnSync(PEN, ['resume', snap, '41'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('42');
  
  cleanup(snap);
});
```

- [ ] **Step 2: Build and run**

Run: `npm run build && npm test -- integration`
Expected: All integration tests PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): demo 2 — nested-function pause"
```

---

## Task 28: Integration — demo 3 (fork)

**Files:**
- Modify: `test/integration.test.ts`

- [ ] **Step 1: Append the demo 3 test**

Add to `test/integration.test.ts`:

```ts
test('demo 3: fork produces two independent futures from one snapshot', () => {
  const source = resolve('examples/03-fork.pen');
  const snap = resolve('examples/03-fork.penz');
  const fork0 = resolve('examples/03-fork.fork0.penz');
  const fork1 = resolve('examples/03-fork.fork1.penz');
  cleanup(snap); cleanup(fork0); cleanup(fork1);
  
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);
  
  // Fork with 5 and 10; expect both prints.
  const r2 = spawnSync(PEN, ['fork', snap, '5', '10'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  
  const lines = r2.stdout.trim().split('\n').sort();
  expect(lines).toEqual([
    '[fork-0] 105',
    '[fork-1] 110',
  ]);
  
  cleanup(snap); cleanup(fork0); cleanup(fork1);
});
```

- [ ] **Step 2: Build and run**

Run: `npm run build && npm test -- integration`
Expected: All three integration tests PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): demo 3 — fork"
```

---

## Task 29: Docs — Phase 1 status section in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append the Phase 1 Status section**

Append to `README.md` (before the `## License` section):

```markdown
---

## Phase 1 Status

**Status:** ✅ Complete (as of <date when Task 29 is done>)

Phase 1 ships a working tiny Penelope: a hand-written lexer + recursive-descent parser + tree-walking step-machine interpreter in TypeScript, with `pause` as the only special primitive. Every execution state is plain JSON data; `JSON.stringify(state)` is the snapshot format.

### Try it

```bash
git clone <this repo>
cd Penelope
npm install
npm run build

# Demo 1: top-level pause
./bin/penelope run examples/01-toplevel-pause.pen
./bin/penelope resume examples/01-toplevel-pause.penz 5
# → prints 15

# Demo 2: nested-function pause
./bin/penelope run examples/02-nested-pause.pen
./bin/penelope resume examples/02-nested-pause.penz 41
# → prints 42

# Demo 3: fork
./bin/penelope run examples/03-fork.pen
./bin/penelope fork examples/03-fork.penz 5 10
# → prints [fork-0] 105 and [fork-1] 110

# Bonus: inspect a paused snapshot
./bin/penelope run examples/01-toplevel-pause.pen
./bin/penelope inspect examples/01-toplevel-pause.penz
```

### What's next

Phase 2 (effect system) and Phase 3 (bytecode VM + live editing) are not yet started. See `docs/superpowers/specs/2026-05-22-penelope-phase-1-design.md` §17 for forward-compatibility notes.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): Phase 1 status, try-it commands, what's next"
```

---

## Final Verification

After all tasks, run the full suite and walk the three demos by hand:

```bash
npm run build && npm test
```

Expected: all tests PASS, exit 0.

Then walk each demo from §11 of the spec to confirm reproducibility. When all three demos print the expected output from a fresh clone, **Phase 1 is complete**.
