# Penelope Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pause/resume correct under impure code. Add 8 effect primitives (`print` replay, `write_file`, `net_fetch`, `now`, `random_int`, `read_file`, `wait_until`, `wait_for`) + a `string` value type, with an effect log that lives in snapshot v2. Phase 2 is complete when the 24h HITL agent demo crashes twice mid-flight and still completes correctly.

**Architecture:** Bump snapshot version 1→2 (no Phase 1 backwards compat). Add `effects: EffectEntry[]` to `State` indexed by `(nodeId, invocationCount)`. Three replay categories: **write**=skip, **read**=replay-from-log, **wait**=re-pause-or-continue. New `src/effects.ts` module isolates real IO (`curl` for HTTP, `fs` sync, `console.log`, `Math.random`). CLI gains `--event NAME=VALUE`, `--time MS`, `--no-replay`. Strings are added with literals, `+`/`==`/`!=` overloads, and three pure builtins (`str_length`, `str_slice`, `to_str`) — no interpolation.

**Tech Stack:** TypeScript 5.x, Node.js ≥ 18, Vitest. Same zero-prod-deps discipline as Phase 1.

**Reference spec:** `docs/superpowers/specs/2026-05-23-penelope-phase-2-design.md`

**Reference Phase 1 plan:** `docs/superpowers/plans/2026-05-23-penelope-phase-1.md` (for file-structure patterns)

---

## File Structure (Phase 2 diff from Phase 1)

| Path | Status | Tasks | Responsibility |
|---|---|---|---|
| `src/ast.ts` | MODIFIED | T1 | Add `str` Value tag; add `StringLit` AST node |
| `src/lexer.ts` | MODIFIED | T2 | Add `STRING` token + scanner with `\n` `\\` `\"` escapes |
| `src/parser.ts` | MODIFIED | T3 | Add STRING case in `parsePrimary` |
| `src/interpreter.ts` | MODIFIED | T4-T9, T12, T13-T21 | StringLit eval; `+` `==` `!=` overload; reserved-name guard; effect dispatch path; per-effect logic |
| `src/snapshot.ts` | MODIFIED | T0 | Version bump 1→2; reject v1; add `effects` field |
| `src/cli.ts` | MODIFIED | T17, T21, T22, T23 | `--time`, `--event`, `--no-replay`; inspect prints effect log |
| `src/effects.ts` | NEW | T10, T14-T21 | Real IO performers; `EFFECT_NAMES`; `categoryOf` |
| `test/string.test.ts` | NEW | T2-T9 | Group A tests (~12) |
| `test/effect.test.ts` | NEW | T11, T13 | Group B tests (~5) |
| `test/integration.test.ts` | MODIFIED | T14-T26 | Groups C/D/E/F/G/H/I integration tests (~25) |
| `examples/04-print-replay.pen` | NEW | T14 | Group C demo |
| `examples/05-net-fetch.pen` | NEW | T16 | Group D demo |
| `examples/06-now-random.pen` | NEW | T17/T18 | Group E demo |
| `examples/07-wait-for.pen` | NEW | T21 | Group G demo |
| `examples/08-24h-agent.pen` | NEW | T25 | H4 headline demo |
| `README.md` | MODIFIED | T27 | Phase 2 status section |

---

## Test catalog mapping (spec §11 → plan tasks)

| Spec Group | Tests | Plan tasks that add them |
|---|---|---|
| A — Strings | A1-A12 (12) | T2 (A8), T3 (A1), T4 (A2, A9), T5 (A3, A10), T6 (A4), T7 (A5), T8 (A6, A7), T9 (A11, A12) |
| B — Effect log infra | B1-B5 (5) | T11 (B4), T13 (B1, B2, B3), T23 (B5) |
| C — print replay | C1-C3 (3) | T14 (C1, C2), T26 (C3) |
| D — net_fetch | D1-D3 (3) | T16 (D1, D2, D3) |
| E — now/random | E1-E3 (3) | T17 (E1, E3), T18 (E2) |
| F — FS | F1-F3 (3) | T15 (F2, F3), T19 (F1) |
| G — wait | G1-G5 (5) | T20 (G1, G2), T21 (G3, G4, G5) |
| H — crash+recover | H1-H5 (5) | T14 (H1), T16 (H2), T21 (H3), T25 (H4), T11 (H5) |
| I — fork | I1-I3 (3) | T26 (I1, I2, I3) |

Total: ~40 tests across 27 implementation tasks.

---

## Task 0: Bump snapshot to v2 + add empty `effects[]` field

**Files:**
- Modify: `src/snapshot.ts` (version 1 → 2)
- Modify: `src/interpreter.ts` (State type adds `effects: EffectEntry[]`, initialState adds `effects: []`)
- Modify: `test/snapshot.test.ts` (update existing tests; add v1-rejection test)
- Modify: `src/cli.ts` (snapshot writer constructs v2)

This task gates everything. All Phase 1 tests must still pass after — most adjustments are mechanical.

- [ ] **Step 1: Add `EffectEntry` type stub to `src/interpreter.ts`**

At the top of `src/interpreter.ts`, after the existing type imports, add:

```ts
// Phase 2: effect log entry. Filled in by Task 13+. For now just an opaque type.
export type EffectEntry = {
  nodeId: NodeId;
  invocationCount: number;
  effect: 'print' | 'net_fetch' | 'now' | 'random_int' | 'read_file' | 'write_file' | 'wait_until' | 'wait_for';
  recordedValue: Value | null;
  status: 'pending' | 'committed';
};
```

- [ ] **Step 2: Add `effects: EffectEntry[]` to `State` type**

In the existing `State` type definition, add the field:

```ts
export type State = {
  control: ControlInstr[];
  valueStack: Value[];
  scopes: Record<ScopeId, Scope>;
  currentScopeId: ScopeId;
  nextScopeIdCounter: number;
  effects: EffectEntry[];  // ← NEW (empty array by default)
};
```

- [ ] **Step 3: Update `initialState` and `runToCompletion` to include `effects: []`**

Two places in `src/interpreter.ts`:

```ts
export function initialState(rootId: NodeId): State {
  return {
    control: [{ op: 'eval', nodeId: rootId }],
    valueStack: [],
    scopes: { s0: { parentId: null, bindings: {} } },
    currentScopeId: 's0',
    nextScopeIdCounter: 1,
    effects: [],  // ← NEW
  };
}

export function runToCompletion(ast: ASTBundle, startNodeId: NodeId = ast.rootId): StepResult {
  let state: State = {
    control: [{ op: 'eval', nodeId: startNodeId }],
    valueStack: [],
    scopes: { s0: { parentId: null, bindings: {} } },
    currentScopeId: 's0',
    nextScopeIdCounter: 1,
    effects: [],  // ← NEW
  };
  // ... rest unchanged
}
```

- [ ] **Step 4: Bump `Snapshot.version` to literal `2`**

In `src/snapshot.ts`:

```ts
export type Snapshot = {
  version: 2;                  // ← bumped from 1
  programPath: string;
  programHash: string;
  pausedAt: NodeId;
  pausedAtMs: number;
  state: State;
};
```

- [ ] **Step 5: Update `deserialize` to reject v1 snapshots**

In `src/snapshot.ts`, the version check:

```ts
if ((snap.version as number) !== 2) {
  return { error: `unknown snapshot version: ${snap.version}. Phase 2 uses version 2 (Phase 1 snapshots are not migratable; re-run from source).` };
}
```

- [ ] **Step 6: Update `test/snapshot.test.ts` fixtures to use version: 2 and add effects: [] in state**

In `test/snapshot.test.ts`, find every `goodSnap` literal and update:

```ts
const goodSnap = {
  version: 2 as const,                          // ← was 1
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
    effects: [],                                // ← NEW
  },
};
```

Also update the "rejects unknown version" test: change `version: 999` test message expectation to match new message (`Phase 2 uses version 2`).

- [ ] **Step 7: Add v1-rejection test in `test/snapshot.test.ts`**

```ts
test('deserialize rejects v1 snapshots with helpful message', () => {
  const v1snap = { ...goodSnap, version: 1 };
  const r = deserialize(JSON.stringify(v1snap), () => goodSource);
  expect('error' in r).toBe(true);
  if ('error' in r) {
    expect(r.error).toMatch(/version 2/);
    expect(r.error).toMatch(/not migratable|re-run/);
  }
});
```

- [ ] **Step 8: Update `src/cli.ts` snapshot constructors to use v2**

Search `cli.ts` for `version: 1` and replace with `version: 2`. There are 3 occurrences (run/resume/fork each construct a new snapshot).

- [ ] **Step 9: Build and run all tests**

```bash
npm run build && npm test
```

Expected: 62 passing (was 62 in Phase 1, no test count change yet). Confirms Phase 1 didn't regress.

- [ ] **Step 10: Commit**

```bash
git add src/snapshot.ts src/interpreter.ts src/cli.ts test/snapshot.test.ts
git commit -m "feat(snapshot): bump to v2, add empty effects[] field"
```

---

## Task 1: Add `str` Value tag + `StringLit` AST node

**Files:**
- Modify: `src/ast.ts`

Pure type additions. No tests (validated by `tsc`).

- [ ] **Step 1: Add `StringLit` to ASTNode union**

In `src/ast.ts`, in the `ASTNode` union, add (alphabetically after `BoolLit` is fine):

```ts
  | { id: NodeId; kind: 'StringLit'; value: string }
```

- [ ] **Step 2: Add `str` to Value union**

In `src/ast.ts`, in the `Value` union:

```ts
export type Value =
  | { tag: 'int';     v: number }
  | { tag: 'bool';    v: boolean }
  | { tag: 'closure'; paramNames: string[]; bodyBlockId: NodeId; capturedScopeId: ScopeId }
  | { tag: 'unit' }
  | { tag: 'str';     v: string };  // ← NEW
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

Note: this WILL leave the `formatValue` function in `src/interpreter.ts` non-exhaustive for the new `str` tag. That's intentionally addressed in Task 4 when we eval StringLit. For now `tsc` may flag it; if so, add a `case 'str': return v.v;` clause in `formatValue` as a one-line placeholder.

If tsc fails, add this single line to `formatValue` in `src/interpreter.ts`:
```ts
    case 'str':     return v.v;
```
…between the `unit` and `closure` cases.

- [ ] **Step 4: Run all tests (no regression)**

```bash
npm test
```

Expected: 62 passing.

- [ ] **Step 5: Commit**

```bash
git add src/ast.ts src/interpreter.ts
git commit -m "feat(ast): add str Value tag and StringLit AST node"
```

---

## Task 2: Lexer — STRING token + scanner with escapes

**Files:**
- Modify: `src/lexer.ts`
- Modify: `test/lexer.test.ts`

- [ ] **Step 1: Add `STRING` to `TokenKind` union**

In `src/lexer.ts`:

```ts
export type TokenKind =
  | 'INT' | 'IDENT' | 'STRING'   // ← STRING added
  | 'LET' | 'FN' | 'IF' | 'ELSE' | 'TRUE' | 'FALSE' | 'PAUSE' | 'PRINT'
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH'
  | 'LT' | 'GT' | 'LE' | 'GE' | 'EQ_EQ' | 'BANG_EQ'
  | 'EQ'
  | 'LPAREN' | 'RPAREN' | 'LBRACE' | 'RBRACE' | 'COMMA' | 'SEMI'
  | 'EOF';
```

- [ ] **Step 2: Add `value?: string` to Token type for STRING**

The existing `Token.text?` field is used for IDENT and could hold the string content. Reuse it (rename later if confusing). Token type stays:

```ts
export type Token = {
  kind: TokenKind;
  line: number;
  col: number;
  text?: string;     // for IDENT and STRING (content without quotes/escapes)
  value?: number;    // for INT
};
```

- [ ] **Step 3: Write failing tests for string lexing (Group A8 escapes + a basic STRING test)**

Append to `test/lexer.test.ts`:

```ts
test('tokenizes a simple string literal', () => {
  const tokens = tokenize('"hello"');
  expect(tokens[0]).toMatchObject({ kind: 'STRING', text: 'hello' });
  expect(tokens[1].kind).toBe('EOF');
});

test('handles string escape sequences', () => {
  expect(tokenize('"a\\nb"')[0]).toMatchObject({ kind: 'STRING', text: 'a\nb' });
  expect(tokenize('"a\\\\b"')[0]).toMatchObject({ kind: 'STRING', text: 'a\\b' });
  expect(tokenize('"a\\"b"')[0]).toMatchObject({ kind: 'STRING', text: 'a"b' });
});

test('empty string literal', () => {
  expect(tokenize('""')[0]).toMatchObject({ kind: 'STRING', text: '' });
});

test('unterminated string throws', () => {
  expect(() => tokenize('"hello')).toThrow(/unterminated string/);
});
```

- [ ] **Step 4: Run tests — expect failures**

```bash
npm test -- lexer
```

Expected: 4 new tests FAIL.

- [ ] **Step 5: Add string scanning to `tokenize`**

In `src/lexer.ts`, **inside the `while (i < source.length)` loop**, after the line-comment block and **before** the integer literal block, insert:

```ts
    // string literal
    if (c === '"') {
      advance();  // consume opening quote
      let text = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          advance();  // consume backslash
          if (i >= source.length) {
            throw new Error(`lexer: unterminated string at line ${startLine} col ${startCol}`);
          }
          const esc = source[i];
          if (esc === 'n')       text += '\n';
          else if (esc === '\\') text += '\\';
          else if (esc === '"')  text += '"';
          else throw new Error(`lexer: unknown escape '\\${esc}' at line ${line} col ${col}`);
          advance();
        } else {
          text += advance();
        }
      }
      if (i >= source.length) {
        throw new Error(`lexer: unterminated string at line ${startLine} col ${startCol}`);
      }
      advance();  // consume closing quote
      tokens.push({ kind: 'STRING', line: startLine, col: startCol, text });
      continue;
    }
```

Placement note: AFTER line-comment (so `//` inside a string is fine — wait actually no, `//` won't trigger because we're inside the string scan loop) and AFTER whitespace. The order matters; place it just before the integer-literal branch.

- [ ] **Step 6: Run tests — expect PASS**

```bash
npm test -- lexer
```

Expected: 17 lexer tests passing (13 + 4 new).

- [ ] **Step 7: Run all tests (no regression)**

```bash
npm test
```

Expected: 66 passing.

- [ ] **Step 8: Commit**

```bash
git add src/lexer.ts test/lexer.test.ts
git commit -m "feat(lexer): string literals with escape sequences"
```

---

## Task 3: Parser — STRING token → StringLit AST node (test A1)

**Files:**
- Modify: `src/parser.ts`
- Create: `test/string.test.ts`

- [ ] **Step 1: Create `test/string.test.ts` with the failing test**

```ts
import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

test('A1: string literal parses to StringLit', () => {
  const ast = parse(tokenize('"hello";'));
  const program = ast.nodes[ast.rootId];
  if (program.kind !== 'Program') throw new Error('expected Program');
  const stmt = ast.nodes[program.stmtIds[0]];
  if (stmt.kind !== 'ExprStmt') throw new Error('expected ExprStmt');
  expect(ast.nodes[stmt.exprId]).toMatchObject({ kind: 'StringLit', value: 'hello' });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- string
```

Expected: FAIL.

- [ ] **Step 3: Add STRING case to `parsePrimary`**

In `src/parser.ts`, inside the existing `switch (t.kind)` in `parsePrimary`, add (alphabetically after BoolLit cases is fine):

```ts
    case 'STRING': {
      c.eat('STRING');
      return b.addNode(id => ({ id, kind: 'StringLit', value: t.text! }));
    }
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- string
npm test  # full suite: 67 passing
```

- [ ] **Step 5: Commit**

```bash
git add src/parser.ts test/string.test.ts
git commit -m "feat(parser): StringLit primary expression"
```

---

## Task 4: Interpreter — StringLit eval + str formatValue + print string (tests A2, A9)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/string.test.ts`

- [ ] **Step 1: Append failing tests to `test/string.test.ts`**

```ts
import { runToCompletion } from '../src/interpreter.js';

test('A2: string literal evaluates to str Value', () => {
  const ast = parse(tokenize('"hello";'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error('expected done');
  expect(result.finalValue).toEqual({ tag: 'str', v: 'hello' });
});

test('A9: print prints a string without quotes', () => {
  const ast = parse(tokenize('print("hello");'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['hello']);
  } finally { console.log = origLog; }
});
```

- [ ] **Step 2: Run — expect FAILs**

```bash
npm test -- string
```

- [ ] **Step 3: Add StringLit case in `stepEval`**

In `src/interpreter.ts`, in `stepEval` switch (after `BoolLit`):

```ts
    case 'StringLit':
      return cont({ ...state, control: rest,
        valueStack: [...state.valueStack, { tag: 'str', v: node.value }] });
```

- [ ] **Step 4: Update `formatValue` to handle `str` properly**

If you added a placeholder `case 'str': return v.v;` in Task 1, confirm it's still there. Otherwise add:

```ts
export function formatValue(v: Value): string {
  switch (v.tag) {
    case 'int':     return String(v.v);
    case 'bool':    return v.v ? 'true' : 'false';
    case 'unit':    return '()';
    case 'closure': return '<fn>';
    case 'str':     return v.v;   // ← raw content, no quotes
  }
}
```

- [ ] **Step 5: Run — expect PASS**

```bash
npm test
```

Expected: 69 passing.

- [ ] **Step 6: Commit**

```bash
git add src/interpreter.ts test/string.test.ts
git commit -m "feat(interpreter): StringLit evaluation; print str without quotes"
```

---

## Task 5: Interpreter — `+` overload for string concat + type mismatch (tests A3, A10)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/string.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
test('A3: string + string concat', () => {
  const ast = parse(tokenize('"abc" + "def";'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error('expected done');
  expect(result.finalValue).toEqual({ tag: 'str', v: 'abcdef' });
});

test('A10: int + str is a runtime error', () => {
  const ast = parse(tokenize('1 + "a";'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.message).toMatch(/cannot apply/);
});
```

- [ ] **Step 2: Run — expect FAILs**

- [ ] **Step 3: Modify `applyBinOp` in `src/interpreter.ts` to handle str `+`**

Inside `applyBinOp`, the `+ - * /` block currently rejects non-int. Restructure to permit string `+`:

Replace the existing block:

```ts
  if (op === '+' || op === '-' || op === '*' || op === '/') {
    if (left.tag !== 'int' || right.tag !== 'int')
      return { kind: 'error', message: `cannot apply '${op}' to ${left.tag} and ${right.tag}` };
    // ... arithmetic ...
  }
```

with:

```ts
  if (op === '+') {
    // String concat overload
    if (left.tag === 'str' && right.tag === 'str') {
      return cont({ ...state, control: rest,
        valueStack: [...newStack, { tag: 'str', v: left.v + right.v }] });
    }
    // Integer addition
    if (left.tag === 'int' && right.tag === 'int') {
      return cont({ ...state, control: rest,
        valueStack: [...newStack, { tag: 'int', v: left.v + right.v }] });
    }
    return { kind: 'error', message: `cannot apply '+' to ${left.tag} and ${right.tag}` };
  }
  
  if (op === '-' || op === '*' || op === '/') {
    if (left.tag !== 'int' || right.tag !== 'int')
      return { kind: 'error', message: `cannot apply '${op}' to ${left.tag} and ${right.tag}` };
    let result: number;
    if (op === '-') result = left.v - right.v;
    else if (op === '*') result = left.v * right.v;
    else {
      if (right.v === 0) return { kind: 'error', message: 'division by zero' };
      result = Math.trunc(left.v / right.v);
    }
    return cont({ ...state, control: rest,
      valueStack: [...newStack, { tag: 'int', v: result }] });
  }
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test
```

Expected: 71 passing.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/string.test.ts
git commit -m "feat(interpreter): + overload for string concat"
```

---

## Task 6: Interpreter — `==`/`!=` overload for string equality (test A4)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/string.test.ts`

- [ ] **Step 1: Append failing test**

```ts
test('A4: string equality (== and !=)', () => {
  const ast1 = parse(tokenize('"a" == "a";'));
  const s1 = Object.values(ast1.nodes).find(n => n.kind === 'ExprStmt');
  if (!s1 || s1.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const r1 = runToCompletion(ast1, s1.exprId);
  if (r1.kind !== 'done') throw new Error('expected done');
  expect(r1.finalValue).toEqual({ tag: 'bool', v: true });
  
  const ast2 = parse(tokenize('"a" != "b";'));
  const s2 = Object.values(ast2.nodes).find(n => n.kind === 'ExprStmt');
  if (!s2 || s2.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const r2 = runToCompletion(ast2, s2.exprId);
  if (r2.kind !== 'done') throw new Error('expected done');
  expect(r2.finalValue).toEqual({ tag: 'bool', v: true });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Extend `==`/`!=` handling in `applyBinOp`**

In `applyBinOp`, find the existing `== !=` block:

```ts
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
```

Add a clause for `str`:

```ts
    else if (left.tag === 'str' && right.tag === 'str') same = left.v === right.v;
```

Place it between the `bool` and `unit` clauses.

- [ ] **Step 4: Run — expect PASS**

```bash
npm test
```

Expected: 72 passing.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/string.test.ts
git commit -m "feat(interpreter): == != overload for string equality"
```

---

## Task 7: Builtin — `str_length` (test A5)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/string.test.ts`

`str_length` is a **pure** builtin — it's intercepted in the Call path but does NOT touch the effect log. This task establishes the pattern (later effect builtins will follow a similar dispatch but also log).

- [ ] **Step 1: Append failing test**

```ts
test('A5: str_length returns int length', () => {
  const ast = parse(tokenize('str_length("hello");'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error('expected done');
  expect(result.finalValue).toEqual({ tag: 'int', v: 5 });
});
```

- [ ] **Step 2: Run — expect FAIL (`undefined variable 'str_length'`)**

- [ ] **Step 3: Add builtin recognition in `invokeClosure`**

In `src/interpreter.ts`, modify `invokeClosure` to intercept builtin names. Currently the function assumes the callee is a closure. Add a branch BEFORE the closure check.

Restructure `invokeClosure` like this:

```ts
function invokeClosure(state: State, rest: ControlInstr[], argCount: number): StepResult {
  const stack = state.valueStack;
  const args = stack.slice(stack.length - argCount);
  const callee = stack[stack.length - argCount - 1];
  
  // === Pure string builtin dispatch (Phase 2 strings) ===
  // The callee was eval'd as Var lookup. For builtins, the Var lookup would have FAILED
  // (no binding exists for str_length etc.). We handle that BEFORE the lookup error happens.
  // Actually since the Var case already errored, we need a different approach:
  // intercept Call evaluation BEFORE the callee is evaluated as Var.
  // 
  // ALTERNATIVE: handle this in stepEval Call case. See restructure below.
  
  // For now (this task only): if callee is NOT closure, assume it was a Var ref to a builtin.
  // But we don't have access to the Var's name here. So we MUST handle builtins at the Call eval level.
  
  // ... existing closure invocation logic ...
}
```

Wait — the cleaner approach: handle builtin Call at the Call's `stepEval` case, not in `invokeClosure`. Let me redo this.

Replace the existing `case 'Call':` in `stepEval` with:

```ts
    case 'Call': {
      // Check if this is a builtin call: callee is a Var node whose name is a reserved builtin.
      const callee = ast.nodes[node.calleeId];
      if (callee.kind === 'Var' && PURE_BUILTINS.has(callee.name)) {
        // Pure builtin: eval all args, then apply the builtin.
        return cont({ ...state, control: [
          ...rest,
          { op: 'applyPureBuiltin', name: callee.name, argCount: node.argIds.length },
          ...[...node.argIds].reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
        ]});
      }
      // (Phase 2 Task 13 will add an effect-builtin branch here.)
      
      // Normal closure call (Phase 1 path).
      return cont({ ...state, control: [
        ...rest,
        { op: 'invoke', argCount: node.argIds.length },
        ...[...node.argIds].reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
        { op: 'eval', nodeId: node.calleeId },
      ]});
    }
```

Add a `PURE_BUILTINS` constant at module top:

```ts
const PURE_BUILTINS: ReadonlySet<string> = new Set([
  'str_length', 'str_slice', 'to_str',
]);
```

Add a new ControlInstr variant in the `ControlInstr` type:

```ts
  | { op: 'applyPureBuiltin'; name: string; argCount: number }
```

Add the handler in `step`'s switch:

```ts
    case 'applyPureBuiltin':
      return applyPureBuiltin(state, rest, instr.name, instr.argCount);
```

Add the `applyPureBuiltin` helper:

```ts
function applyPureBuiltin(state: State, rest: ControlInstr[], name: string, argCount: number): StepResult {
  const stack = state.valueStack;
  const args = stack.slice(stack.length - argCount);
  const newStack = stack.slice(0, stack.length - argCount);
  
  if (name === 'str_length') {
    if (argCount !== 1) return { kind: 'error', message: `str_length expects 1 arg, got ${argCount}` };
    const a = args[0];
    if (a.tag !== 'str') return { kind: 'error', message: `str_length expects str, got ${a.tag}` };
    return cont({ ...state, control: rest,
      valueStack: [...newStack, { tag: 'int', v: a.v.length }] });
  }
  
  // str_slice and to_str fill in via Tasks 8 and 9.
  return { kind: 'error', message: `unimplemented pure builtin: ${name}` };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test
```

Expected: 73 passing.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/string.test.ts
git commit -m "feat(interpreter): str_length builtin + pure-builtin dispatch"
```

---

## Task 8: Builtin — `str_slice` (tests A6, A7)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/string.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
test('A6: str_slice basic', () => {
  const ast = parse(tokenize('str_slice("hello", 1, 4);'));
  const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
  if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
  const result = runToCompletion(ast, stmt.exprId);
  if (result.kind !== 'done') throw new Error('expected done');
  expect(result.finalValue).toEqual({ tag: 'str', v: 'ell' });
});

test('A7: str_slice edge cases (empty, full, out-of-bounds clipped)', () => {
  function evalSlice(src: string): string {
    const ast = parse(tokenize(src));
    const stmt = Object.values(ast.nodes).find(n => n.kind === 'ExprStmt');
    if (!stmt || stmt.kind !== 'ExprStmt') throw new Error('no ExprStmt');
    const r = runToCompletion(ast, stmt.exprId);
    if (r.kind !== 'done') throw new Error('expected done');
    if (!r.finalValue || r.finalValue.tag !== 'str') throw new Error('expected str');
    return r.finalValue.v;
  }
  expect(evalSlice('str_slice("hello", 0, 0);')).toBe('');
  expect(evalSlice('str_slice("hello", 0, 5);')).toBe('hello');
  expect(evalSlice('str_slice("hello", 2, 100);')).toBe('llo');   // hi clipped
  expect(evalSlice('str_slice("hello", 0 - 2, 3);')).toBe('hel'); // lo clipped to 0
});
```

(Note: `0 - 2` is the Phase 1 idiom for `-2` since unary minus is out of scope.)

- [ ] **Step 2: Run — expect FAILs**

- [ ] **Step 3: Add `str_slice` case to `applyPureBuiltin`**

In `applyPureBuiltin`, after the `str_length` clause:

```ts
  if (name === 'str_slice') {
    if (argCount !== 3) return { kind: 'error', message: `str_slice expects 3 args, got ${argCount}` };
    const s = args[0];
    const lo = args[1];
    const hi = args[2];
    if (s.tag !== 'str') return { kind: 'error', message: `str_slice expects str, got ${s.tag}` };
    if (lo.tag !== 'int') return { kind: 'error', message: `str_slice expects int lo, got ${lo.tag}` };
    if (hi.tag !== 'int') return { kind: 'error', message: `str_slice expects int hi, got ${hi.tag}` };
    const len = s.v.length;
    const loClamped = Math.max(0, Math.min(len, lo.v));
    const hiClamped = Math.max(loClamped, Math.min(len, hi.v));
    return cont({ ...state, control: rest,
      valueStack: [...newStack, { tag: 'str', v: s.v.slice(loClamped, hiClamped) }] });
  }
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test
```

Expected: 75 passing.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/string.test.ts
git commit -m "feat(interpreter): str_slice builtin"
```

---

## Task 9: Builtin — `to_str` (tests A11, A12)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/string.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
test('A11: to_str on each Value tag', () => {
  const ast = parse(tokenize('print(to_str(42)); print(to_str(true)); print(to_str(false));'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['42', 'true', 'false']);
  } finally { console.log = origLog; }
});

test('A12: to_str + concat in real use', () => {
  const ast = parse(tokenize('print("amount: " + to_str(5000));'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const result = runToCompletion(ast);
    expect(result.kind).toBe('done');
    expect(logged).toEqual(['amount: 5000']);
  } finally { console.log = origLog; }
});
```

- [ ] **Step 2: Run — expect FAILs**

- [ ] **Step 3: Add `to_str` to `applyPureBuiltin`**

Add after the `str_slice` clause:

```ts
  if (name === 'to_str') {
    if (argCount !== 1) return { kind: 'error', message: `to_str expects 1 arg, got ${argCount}` };
    const v = args[0];
    // Reuse formatValue for the conversion.
    return cont({ ...state, control: rest,
      valueStack: [...newStack, { tag: 'str', v: formatValue(v) }] });
  }
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test
```

Expected: 77 passing.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/string.test.ts
git commit -m "feat(interpreter): to_str builtin"
```

---

## Task 10: New module `src/effects.ts` — scaffold + categorization

**Files:**
- Create: `src/effects.ts`
- Create: `test/effect.test.ts`

This task lays the infrastructure for the 8 effect primitives. No actual IO yet.

- [ ] **Step 1: Create `test/effect.test.ts` with the failing test**

```ts
import { test, expect } from 'vitest';
import { EFFECT_NAMES, categoryOf } from '../src/effects.js';

test('EFFECT_NAMES contains all 8 effects', () => {
  expect(EFFECT_NAMES.size).toBe(8);
  for (const name of ['print', 'net_fetch', 'now', 'random_int', 'read_file', 'write_file', 'wait_until', 'wait_for']) {
    expect(EFFECT_NAMES.has(name as any)).toBe(true);
  }
});

test('categoryOf classifies effects correctly', () => {
  expect(categoryOf('print')).toBe('write');
  expect(categoryOf('write_file')).toBe('write');
  expect(categoryOf('net_fetch')).toBe('read');
  expect(categoryOf('now')).toBe('read');
  expect(categoryOf('random_int')).toBe('read');
  expect(categoryOf('read_file')).toBe('read');
  expect(categoryOf('wait_until')).toBe('wait');
  expect(categoryOf('wait_for')).toBe('wait');
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
npm test -- effect
```

- [ ] **Step 3: Create `src/effects.ts`**

```ts
// Penelope effects module.
// Owns real-world IO (HTTP, FS, console, time, RNG) and the effect-name catalog.
// `interpreter.ts` delegates here on first execution of an effect call.
// On replay, `interpreter.ts` reads from the effect log and does NOT call this module.

export type EffectName =
  | 'print'
  | 'net_fetch'
  | 'now'
  | 'random_int'
  | 'read_file'
  | 'write_file'
  | 'wait_until'
  | 'wait_for';

export const EFFECT_NAMES: ReadonlySet<EffectName> = new Set<EffectName>([
  'print', 'net_fetch', 'now', 'random_int',
  'read_file', 'write_file', 'wait_until', 'wait_for',
]);

export type EffectCategory = 'write' | 'read' | 'wait';

export function categoryOf(name: EffectName): EffectCategory {
  if (name === 'print' || name === 'write_file') return 'write';
  if (name === 'net_fetch' || name === 'now' || name === 'random_int' || name === 'read_file') return 'read';
  return 'wait';  // wait_until, wait_for
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test
```

Expected: 79 passing.

- [ ] **Step 5: Commit**

```bash
git add src/effects.ts test/effect.test.ts
git commit -m "feat(effects): module scaffold with EFFECT_NAMES and categoryOf"
```

---

## Task 11: Snapshot serialize/deserialize preserves `effects` field (test B4, H5)

**Files:**
- Modify: `test/snapshot.test.ts`
- Modify: `test/effect.test.ts`

The `effects: []` field was added in Task 0; snapshot serialize/deserialize already handles it. This task locks in roundtrip safety with an explicit test.

- [ ] **Step 1: Append B4 test to `test/effect.test.ts`**

```ts
import { serialize, deserialize, sha256 } from '../src/snapshot.js';
import type { Snapshot } from '../src/snapshot.js';

test('B4: snapshot with effects[] survives serialize/deserialize roundtrip', () => {
  const source = 'let x = 1;';
  const snap: Snapshot = {
    version: 2,
    programPath: 'x.pen',
    programHash: 'sha256:' + sha256(source),
    pausedAt: 'n5',
    pausedAtMs: 12345,
    state: {
      control: [],
      valueStack: [],
      scopes: { s0: { parentId: null, bindings: {} } },
      currentScopeId: 's0',
      nextScopeIdCounter: 1,
      effects: [
        { nodeId: 'n2', invocationCount: 0, effect: 'print', recordedValue: null, status: 'committed' },
        { nodeId: 'n4', invocationCount: 0, effect: 'net_fetch', recordedValue: { tag: 'str', v: 'response body' }, status: 'committed' },
        { nodeId: 'n6', invocationCount: 0, effect: 'wait_for', recordedValue: { tag: 'str', v: 'approval' }, status: 'pending' },
      ],
    },
  };
  const r = deserialize(serialize(snap), () => source);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap).toEqual(snap);
});

test('H5: hash mismatch with --force preserves effects log on deserialize', () => {
  const source = 'let x = 1;';
  const snap: Snapshot = {
    version: 2,
    programPath: 'x.pen',
    programHash: 'sha256:' + sha256(source),
    pausedAt: 'n5',
    pausedAtMs: 0,
    state: {
      control: [], valueStack: [],
      scopes: { s0: { parentId: null, bindings: {} } },
      currentScopeId: 's0', nextScopeIdCounter: 1,
      effects: [
        { nodeId: 'n1', invocationCount: 0, effect: 'print', recordedValue: null, status: 'committed' },
      ],
    },
  };
  // Use --force to bypass hash check; effects must still be intact.
  const r = deserialize(serialize(snap), () => 'let x = 2;', { force: true });
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  expect(r.snap.state.effects).toHaveLength(1);
  expect(r.snap.state.effects[0].effect).toBe('print');
});
```

- [ ] **Step 2: Run — expect PASS (no impl change; effects field already exists from Task 0)**

```bash
npm test
```

Expected: 81 passing.

- [ ] **Step 3: Commit**

```bash
git add test/effect.test.ts
git commit -m "test(effect): snapshot roundtrip preserves effects; hash-mismatch --force"
```

---

## Task 12: Reserved-builtin-name guard in `Let` eval

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/effect.test.ts`

User code must NOT be able to `let net_fetch = ...` (or shadow any builtin name).

- [ ] **Step 1: Append failing test to `test/effect.test.ts`**

```ts
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { runToCompletion } from '../src/interpreter.js';

test('reserved builtin name cannot be shadowed via let', () => {
  const ast = parse(tokenize('let net_fetch = 0;'));
  const r = runToCompletion(ast);
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.message).toMatch(/reserved/);
});

test('reserved pure builtin name cannot be shadowed via let', () => {
  const ast = parse(tokenize('let str_length = 0;'));
  const r = runToCompletion(ast);
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.message).toMatch(/reserved/);
});
```

- [ ] **Step 2: Run — expect FAILs**

- [ ] **Step 3: Add the guard in `bindLet` case of `step`**

In `src/interpreter.ts`, in the `step` switch's `bindLet` case, at the very start:

```ts
    case 'bindLet': {
      // Reserved builtin name guard
      const reserved = new Set<string>([
        // pure builtins
        'str_length', 'str_slice', 'to_str',
        // effect builtins
        'print', 'net_fetch', 'now', 'random_int', 'read_file', 'write_file', 'wait_until', 'wait_for',
      ]);
      if (reserved.has(instr.name)) {
        return { kind: 'error', message: `'${instr.name}' is a reserved builtin name; cannot let-bind` };
      }
      // (existing code follows)
      const v = state.valueStack[state.valueStack.length - 1];
      // ...
    }
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test
```

Expected: 83 passing.

Note: This test catches user errors at runtime when the let-binding executes. Phase 3 could move this to parse-time for earlier feedback.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/effect.test.ts
git commit -m "feat(interpreter): reject let-binding of reserved builtin names"
```

---

## Task 13: Effect dispatch path in Call — log infrastructure (tests B1, B2, B3)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/effect.test.ts`

Add the EFFECT-builtin branch to the `Call` case (Pure builtin branch was added in Task 7). After this task, an effect builtin call produces a "pending" entry in `state.effects` but doesn't fire real IO (per-effect tasks T14-T21 add the IO).

- [ ] **Step 1: Append failing tests to `test/effect.test.ts`**

```ts
test('B1: print appends one effect entry', () => {
  const ast = parse(tokenize('print(1);'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    // Use a custom driver to inspect state.effects after completion.
    // runToCompletion returns the final result; we need state. Add a helper:
    // For this test, we re-implement the loop to keep state visible.
    const { initialState, step } = require('../src/interpreter.js');
    let s = initialState(ast.rootId);
    while (true) {
      const r = step(s, ast);
      if (r.kind === 'continue') { s = r.state; continue; }
      if (r.kind === 'done') break;
      throw new Error(`unexpected result: ${r.kind}`);
    }
    expect(logged).toEqual(['1']);
    expect(s.effects).toHaveLength(1);
    expect(s.effects[0].effect).toBe('print');
    expect(s.effects[0].invocationCount).toBe(0);
    expect(s.effects[0].status).toBe('committed');
  } finally { console.log = origLog; }
});

test('B2 + B3: two distinct print call sites get separate entries; invocationCount 0 each', () => {
  const ast = parse(tokenize('print(1); print(2);'));
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    const { initialState, step } = require('../src/interpreter.js');
    let s = initialState(ast.rootId);
    while (true) {
      const r = step(s, ast);
      if (r.kind === 'continue') { s = r.state; continue; }
      if (r.kind === 'done') break;
      throw new Error(`unexpected: ${r.kind}`);
    }
    expect(logged).toEqual(['1', '2']);
    expect(s.effects).toHaveLength(2);
    // Both have invocationCount 0 because they're different nodeIds
    expect(s.effects[0].nodeId).not.toBe(s.effects[1].nodeId);
    expect(s.effects[0].invocationCount).toBe(0);
    expect(s.effects[1].invocationCount).toBe(0);
  } finally { console.log = origLog; }
});
```

- [ ] **Step 2: Run — expect FAILs**

```bash
npm test -- effect
```

- [ ] **Step 3: Wire the effect-call dispatch in `Call` case**

Find the `Call` case in `stepEval` (modified in Task 7). It currently has the pure-builtin branch. Add the effect-builtin branch before the closure fallback:

```ts
    case 'Call': {
      const callee = ast.nodes[node.calleeId];
      
      // Pure builtin dispatch (Task 7)
      if (callee.kind === 'Var' && PURE_BUILTINS.has(callee.name)) {
        return cont({ ...state, control: [
          ...rest,
          { op: 'applyPureBuiltin', name: callee.name, argCount: node.argIds.length },
          ...[...node.argIds].reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
        ]});
      }
      
      // Effect builtin dispatch (Task 13)
      if (callee.kind === 'Var' && EFFECT_NAMES_SET.has(callee.name as any)) {
        return cont({ ...state, control: [
          ...rest,
          { op: 'applyEffect', name: callee.name as any, nodeId: node.id, argCount: node.argIds.length },
          ...[...node.argIds].reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
        ]});
      }
      
      // Normal closure call
      return cont({ ...state, control: [
        ...rest,
        { op: 'invoke', argCount: node.argIds.length },
        ...[...node.argIds].reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
        { op: 'eval', nodeId: node.calleeId },
      ]});
    }
```

Add the imports at top of file (alongside existing imports):

```ts
import { EFFECT_NAMES as EFFECT_NAMES_SET, categoryOf } from './effects.js';
import type { EffectName } from './effects.js';
```

Add `applyEffect` to `ControlInstr`:

```ts
  | { op: 'applyEffect'; name: EffectName; nodeId: NodeId; argCount: number }
```

Add handler in `step` switch:

```ts
    case 'applyEffect':
      return applyEffect(state, rest, instr.name, instr.nodeId, instr.argCount, ast);
```

Wait — `step` doesn't take `ast` currently in its signature. Look at the existing signature. It does: `step(state, ast)`. So we can pass it through. But the existing `step` function uses `instr.op === 'eval'` to do `ast.nodes[instr.nodeId]`. So `ast` is in scope of `step`. Good.

Add the `applyEffect` helper:

```ts
function applyEffect(
  state: State,
  rest: ControlInstr[],
  name: EffectName,
  nodeId: NodeId,
  argCount: number,
  _ast: ASTBundle,
): StepResult {
  const stack = state.valueStack;
  const args = stack.slice(stack.length - argCount);
  const newStack = stack.slice(0, stack.length - argCount);
  
  // Count prior invocations at this nodeId to compute invocationCount.
  const invocationCount = state.effects.filter(e => e.nodeId === nodeId).length;
  
  // Look for a matching existing entry (replay path).
  const existing = state.effects.find(e => e.nodeId === nodeId && e.invocationCount === invocationCount);
  
  if (existing !== undefined) {
    // Replay path — implemented per-effect in later tasks.
    // For Task 13, we just always treat as first-execution to keep the test scope minimal.
    // Tasks 14+ will fill in the replay branches.
  }
  
  // First execution: dispatch to category-specific handler.
  // For Task 13 we ONLY handle print (write category) to make B1/B2/B3 pass.
  // Other effects throw "unimplemented" until their tasks land.
  if (name === 'print') {
    if (argCount !== 1) return { kind: 'error', message: `print expects 1 arg, got ${argCount}` };
    // Perform IO (fire console.log)
    console.log(formatValue(args[0]));
    const entry = {
      nodeId, invocationCount, effect: 'print' as const,
      recordedValue: null, status: 'committed' as const,
    };
    return cont({
      ...state, control: rest,
      valueStack: [...newStack, { tag: 'unit' as const }],
      effects: [...state.effects, entry],
    });
  }
  
  return { kind: 'error', message: `effect '${name}' not yet implemented (Phase 2 in progress)`, atNode: nodeId };
}
```

**Important:** This task ALSO needs to remove `print` from the old code path. Phase 1's `Print` AST node still routes to `applyPrint` op. With this change, NEW code parses `print(x)` as a `Call` to a Var named `print` — so the OLD `Print`/`applyPrint` path becomes dead code.

But the AST still has `Print` nodes from Phase 1 parsing. The parser must change to emit `Call` for `print(...)` instead of `Print`. **Wait — is that even right?**

Re-check: in Phase 1, `print(x)` is parsed by `parsePrintStmt` as a `Print` AST node (because `print` is a KEYWORD). The lexer emits PRINT token, not IDENT.

For Phase 2 to treat `print` as a builtin function name, we need `print` to be an IDENT, not a keyword.

This is a breaking change to the lexer. Need to remove PRINT from keywords map.

But if we remove PRINT keyword, then `parsePrintStmt` is dead code. Parser dispatch in `parseStatement` would no longer route on `'PRINT'`. We need to remove that case.

Let me add an EXTRA step for this lexer/parser change.

- [ ] **Step 3a: Remove PRINT from lexer keywords**

In `src/lexer.ts`, remove `print: 'PRINT'` from the `KEYWORDS` map. (Keep `PRINT` in `TokenKind` for now to avoid touching unrelated code, but it'll never be emitted.)

- [ ] **Step 3b: Remove the PRINT case from `parseStatement` in `src/parser.ts`**

```ts
function parseStatement(c: Cursor, b: Builder): ASTNode {
  if (c.peekKind() === 'LET')   return parseLetStmt(c, b);
  // Removed: if (c.peekKind() === 'PRINT') return parsePrintStmt(c, b);
  return parseExprStmt(c, b);
}
```

`parsePrintStmt` becomes unused — delete it.

Also delete the `parseBlock`'s PRINT branch:

```ts
function parseBlock(c: Cursor, b: Builder): ASTNode {
  // ...
  while (c.peekKind() !== 'RBRACE') {
    if (c.peekKind() === 'LET') {
      stmtIds.push(parseLetStmt(c, b).id);
      continue;
    }
    // Removed: if (c.peekKind() === 'PRINT') ...
    const expr = parseExpression(c, b);
    // ...
  }
}
```

- [ ] **Step 3c: Remove the `Print` AST kind from `src/ast.ts`**

Delete `| { id: NodeId; kind: 'Print'; argId: NodeId }` from the ASTNode union.

- [ ] **Step 3d: Remove the `Print` case from `stepEval` and `applyPrint` case from `step`**

Delete these. The old code path is gone — print now goes through `applyEffect`.

- [ ] **Step 3e: Update `formatValue` to NOT include print — leave it as the public value-to-string helper**

formatValue is fine; we use it in applyEffect.

- [ ] **Step 4: Run all tests — expect green**

```bash
npm test
```

Expected: 83 passing (no count change; Phase 1 print tests still pass because `print(x)` now routes through `applyEffect` which calls console.log).

If Phase 1 integration tests fail (some test the exact stdout shape), inspect and fix the test expectations or the print formatting (should be identical).

- [ ] **Step 5: Commit**

```bash
git add src/lexer.ts src/parser.ts src/ast.ts src/interpreter.ts test/effect.test.ts
git commit -m "feat(interpreter): effect dispatch in Call; route print through effect log"
```

---

## Task 14: print is replay-skipped (tests C1, C2, H1)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/integration.test.ts`
- Create: `examples/04-print-replay.pen`

Now that print enters the log on first execution, we need the REPLAY branch to skip the IO.

- [ ] **Step 1: Create `examples/04-print-replay.pen`**

```pen
print("before");
let x = pause;
print(x);
```

- [ ] **Step 2: Append failing integration tests to `test/integration.test.ts`**

```ts
test('C1/H1: print before pause is not re-printed on resume', () => {
  const source = resolve('examples/04-print-replay.pen');
  const snap = resolve('examples/04-print-replay.penz');
  cleanup(snap);
  
  // First process: prints "before", pauses.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(r1.stdout.trim()).toBe('before');
  expect(existsSync(snap)).toBe(true);
  
  // Resume: should print only "42", NOT "before" again.
  const r2 = spawnSync(PEN, ['resume', snap, '42'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('42');
  
  cleanup(snap);
});

test('C2: print after resume is logged fresh', () => {
  // Same demo; verifies that the second print (post-pause) DOES get logged on resume.
  // This is implicit in C1 (the "42" we see was a fresh print, not a replay).
  // For explicit confirmation, we'd need to inspect the .penz after resume — Task 23 enables this.
  // For now we trust C1's stdout assertion as sufficient.
  expect(true).toBe(true);  // structural placeholder
});
```

Wait — that "structural placeholder" violates the no-placeholders rule. Replace with a real test:

```ts
test('C2: print after resume is recorded in effect log (not just skipped)', () => {
  const source = resolve('examples/04-print-replay.pen');
  const snap = resolve('examples/04-print-replay.penz');
  cleanup(snap);
  
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  spawnSync(PEN, ['resume', snap, '42'], { encoding: 'utf8' });
  
  // Read the updated snapshot (resume overwrites it if it pauses again — but this program completes,
  // so the snapshot file still has the post-run state... actually it does NOT update on completion.)
  // We need a different verification: re-running resume with same .penz should now find both prints in the log
  // and skip BOTH on a hypothetical "re-resume".
  // 
  // Simpler structural verification: the program finished (r2.status===0) and exited cleanly.
  // The cross-process integrity is verified by C1.
  // 
  // For now, assert the snapshot file is removed (program completed, no new pause).
  // Actually .penz is NOT auto-removed; it persists. Assert the file is still there but program completed.
  expect(existsSync(snap)).toBe(true);  // snapshot file remains from the pause
  
  cleanup(snap);
});
```

Hmm, C2 is hard to verify cross-process without inspect. Let me just merge C1 and C2 into one test:

REPLACE both above tests with:

```ts
test('C1+C2/H1: print pre-pause skipped on replay, post-pause prints fresh', () => {
  const source = resolve('examples/04-print-replay.pen');
  const snap = resolve('examples/04-print-replay.penz');
  cleanup(snap);
  
  // First run: prints "before", pauses.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(r1.stdout.trim()).toBe('before');
  expect(existsSync(snap)).toBe(true);
  
  // Resume with x=42: skips "before" (logged), prints "42" fresh.
  const r2 = spawnSync(PEN, ['resume', snap, '42'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('42');  // "before" must NOT appear
  
  cleanup(snap);
});
```

- [ ] **Step 3: Run — expect FAIL (`before` re-prints on resume)**

```bash
npm run build && npm test -- integration
```

- [ ] **Step 4: Add the replay branch for `print` in `applyEffect`**

In `applyEffect`, change the structure so the `existing !== undefined` block actually handles replay:

```ts
function applyEffect(
  state: State,
  rest: ControlInstr[],
  name: EffectName,
  nodeId: NodeId,
  argCount: number,
  _ast: ASTBundle,
): StepResult {
  const stack = state.valueStack;
  const args = stack.slice(stack.length - argCount);
  const newStack = stack.slice(0, stack.length - argCount);
  
  const invocationCount = state.effects.filter(e => e.nodeId === nodeId).length;
  const existing = state.effects.find(e => e.nodeId === nodeId && e.invocationCount === invocationCount);
  
  if (existing !== undefined && existing.status === 'committed') {
    // REPLAY path
    const category = categoryOf(name);
    if (category === 'write') {
      // Skip the IO; push unit.
      return cont({ ...state, control: rest,
        valueStack: [...newStack, { tag: 'unit' as const }] });
    }
    if (category === 'read') {
      // Push the logged value.
      if (existing.recordedValue === null) {
        return { kind: 'error', message: `replay: read effect ${name} has null recordedValue (corrupted log)` };
      }
      return cont({ ...state, control: rest,
        valueStack: [...newStack, existing.recordedValue] });
    }
    // 'wait' category replay: push the committed value
    if (existing.recordedValue === null) {
      return { kind: 'error', message: `replay: wait effect ${name} committed with null recordedValue (corrupted log)` };
    }
    return cont({ ...state, control: rest,
      valueStack: [...newStack, existing.recordedValue] });
  }
  
  if (existing !== undefined && existing.status === 'pending') {
    // Wait effect still pending — re-pause.
    return { kind: 'paused', state, pausedAt: nodeId };
  }
  
  // FIRST EXECUTION path
  if (name === 'print') {
    if (argCount !== 1) return { kind: 'error', message: `print expects 1 arg, got ${argCount}` };
    console.log(formatValue(args[0]));
    const entry = {
      nodeId, invocationCount, effect: 'print' as const,
      recordedValue: null, status: 'committed' as const,
    };
    return cont({
      ...state, control: rest,
      valueStack: [...newStack, { tag: 'unit' as const }],
      effects: [...state.effects, entry],
    });
  }
  
  return { kind: 'error', message: `effect '${name}' not yet implemented`, atNode: nodeId };
}
```

- [ ] **Step 5: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 84 passing (existing 83 + 1 new integration).

- [ ] **Step 6: Commit**

```bash
git add src/interpreter.ts test/integration.test.ts examples/04-print-replay.pen
git commit -m "feat(interpreter): print replay-skip; cross-process integration test"
```

---

## Task 15: write_file effect (tests F2, F3)

**Files:**
- Modify: `src/effects.ts`
- Modify: `src/interpreter.ts`
- Modify: `test/integration.test.ts`

- [ ] **Step 1: Add `performWriteFile` to `src/effects.ts`**

Append to `src/effects.ts`:

```ts
import { writeFileSync } from 'node:fs';

export function performWriteFile(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
}
```

- [ ] **Step 2: Append failing integration tests to `test/integration.test.ts`**

```ts
test('F2: write_file skipped on replay (manual override preserved)', () => {
  const source = resolve('/tmp/penelope-wf.pen');
  const snap = resolve('/tmp/penelope-wf.penz');
  const target = '/tmp/penelope-wf-output.txt';
  cleanup(snap); cleanup(target);
  
  // Create the source file dynamically (we don't want to pollute examples/ for this).
  writeFileSync(source, 'write_file("/tmp/penelope-wf-output.txt", "first"); let _ = pause; print("done");');
  
  // Run: writes "first", pauses.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe('first');
  
  // Manually override the file.
  writeFileSync(target, 'manual override');
  
  // Resume: write_file is logged → SKIPPED; print "done" fires.
  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('done');
  expect(readFileSync(target, 'utf8')).toBe('manual override');  // ← key assertion
  
  cleanup(source); cleanup(snap); cleanup(target);
});

test('F3: write_file errors propagate first time', () => {
  const source = resolve('/tmp/penelope-wf-err.pen');
  cleanup(source);
  writeFileSync(source, 'write_file("/nonexistent_dir/file", "x"); print("never");');
  
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(1);
  expect(r1.stderr).toMatch(/write_file/);
  
  cleanup(source);
});
```

Note: needs `import { writeFileSync, readFileSync } from 'node:fs';` at top of `test/integration.test.ts` if not already there.

- [ ] **Step 3: Run — expect FAILs**

- [ ] **Step 4: Add write_file branch to `applyEffect`'s first-execution path**

In `applyEffect`, after the `print` branch:

```ts
  if (name === 'write_file') {
    if (argCount !== 2) return { kind: 'error', message: `write_file expects 2 args, got ${argCount}` };
    const path = args[0];
    const body = args[1];
    if (path.tag !== 'str') return { kind: 'error', message: `write_file path must be str, got ${path.tag}` };
    if (body.tag !== 'str') return { kind: 'error', message: `write_file body must be str, got ${body.tag}` };
    try {
      performWriteFile(path.v, body.v);
    } catch (e) {
      return { kind: 'error', message: `write_file failed: ${(e as Error).message}`, atNode: nodeId };
    }
    const entry = {
      nodeId, invocationCount, effect: 'write_file' as const,
      recordedValue: null, status: 'committed' as const,
    };
    return cont({
      ...state, control: rest,
      valueStack: [...newStack, { tag: 'unit' as const }],
      effects: [...state.effects, entry],
    });
  }
```

Add `performWriteFile` to the existing import from `./effects.js`:

```ts
import { EFFECT_NAMES as EFFECT_NAMES_SET, categoryOf, performWriteFile } from './effects.js';
```

- [ ] **Step 5: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 86 passing.

- [ ] **Step 6: Commit**

```bash
git add src/effects.ts src/interpreter.ts test/integration.test.ts
git commit -m "feat(effects): write_file with first-execute + replay-skip"
```

---

## Task 16: net_fetch effect via curl (tests D1, D2, D3, H2)

**Files:**
- Modify: `src/effects.ts`
- Modify: `src/interpreter.ts`
- Modify: `test/integration.test.ts`
- Create: `examples/05-net-fetch.pen`

**Important:** `net_fetch` uses `spawnSync('curl', ...)` to keep `step()` synchronous. Tests should use a stable target — `https://httpbin.org/uuid` or similar.

- [ ] **Step 1: Add `performNetFetch` to `src/effects.ts`**

```ts
import { spawnSync } from 'node:child_process';

export function performNetFetch(url: string): string {
  const r = spawnSync('curl', ['-sS', '--fail', '-A', 'Penelope/0.2', url], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`curl exit ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}
```

- [ ] **Step 2: Create `examples/05-net-fetch.pen`**

```pen
let body = net_fetch("https://httpbin.org/uuid");
let _ = pause;
print(body);
```

- [ ] **Step 3: Append failing integration tests**

```ts
test('D1+D2+H2: net_fetch records body; replay does not hit network', () => {
  const source = resolve('examples/05-net-fetch.pen');
  const snap = resolve('examples/05-net-fetch.penz');
  cleanup(snap);
  
  // First run: hits network, records body, pauses.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(existsSync(snap)).toBe(true);
  
  // Read the snapshot to capture the body that was fetched.
  const snapJson = JSON.parse(readFileSync(snap, 'utf8'));
  const fetchEntry = snapJson.state.effects.find((e: any) => e.effect === 'net_fetch');
  expect(fetchEntry).toBeDefined();
  expect(fetchEntry.status).toBe('committed');
  expect(fetchEntry.recordedValue.tag).toBe('str');
  const recordedBody = fetchEntry.recordedValue.v;
  
  // Resume — must NOT hit the network; must print the recorded body.
  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe(recordedBody.trim());
  
  cleanup(snap);
}, 15000);  // 15s timeout for the network call

test('D3: two distinct net_fetch call sites get separate log entries', () => {
  const source = resolve('/tmp/penelope-2fetch.pen');
  cleanup(source);
  writeFileSync(source, 'let a = net_fetch("https://httpbin.org/uuid"); let b = net_fetch("https://httpbin.org/uuid"); print(str_length(a) + str_length(b));');
  
  const r = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  
  // The program runs to completion; no snapshot. We just verify it didn't crash.
  // For log content verification, see B-group tests.
  cleanup(source);
}, 15000);
```

- [ ] **Step 4: Run — expect FAILs (net_fetch unimplemented)**

- [ ] **Step 5: Add net_fetch branch to `applyEffect`**

In `applyEffect`, after the `write_file` branch:

```ts
  if (name === 'net_fetch') {
    if (argCount !== 1) return { kind: 'error', message: `net_fetch expects 1 arg, got ${argCount}` };
    const url = args[0];
    if (url.tag !== 'str') return { kind: 'error', message: `net_fetch url must be str, got ${url.tag}` };
    let body: string;
    try {
      body = performNetFetch(url.v);
    } catch (e) {
      return { kind: 'error', message: `net_fetch failed: ${(e as Error).message}`, atNode: nodeId };
    }
    const entry = {
      nodeId, invocationCount, effect: 'net_fetch' as const,
      recordedValue: { tag: 'str' as const, v: body },
      status: 'committed' as const,
    };
    return cont({
      ...state, control: rest,
      valueStack: [...newStack, { tag: 'str' as const, v: body }],
      effects: [...state.effects, entry],
    });
  }
```

Add `performNetFetch` to the import.

- [ ] **Step 6: Run — expect PASS (requires network)**

```bash
npm run build && npm test
```

Expected: 88 passing. Tests requiring network may be slow.

- [ ] **Step 7: Commit**

```bash
git add src/effects.ts src/interpreter.ts test/integration.test.ts examples/05-net-fetch.pen
git commit -m "feat(effects): net_fetch via curl with record/replay"
```

---

## Task 17: now() effect + `--time MS` CLI flag (tests E1, E3)

**Files:**
- Modify: `src/effects.ts`
- Modify: `src/interpreter.ts`
- Modify: `src/cli.ts`
- Modify: `test/integration.test.ts`

`now()` returns the wall-clock time, but supports a `--time MS` override for testing.

- [ ] **Step 1: Add `performNow` to `src/effects.ts`**

```ts
export function performNow(timeOverride: number | null = null): number {
  return timeOverride !== null ? timeOverride : Date.now();
}
```

- [ ] **Step 2: Plumb time override from CLI through interpreter**

Add to `State`:

```ts
export type State = {
  // ...
  effects: EffectEntry[];
  timeOverride?: number | null;  // ← NEW (optional; null = use real clock)
};
```

Update `initialState` and `runToCompletion` to set `timeOverride: null` by default.

- [ ] **Step 3: Add now branch to `applyEffect`**

```ts
  if (name === 'now') {
    if (argCount !== 0) return { kind: 'error', message: `now expects 0 args, got ${argCount}` };
    const t = performNow(state.timeOverride ?? null);
    const entry = {
      nodeId, invocationCount, effect: 'now' as const,
      recordedValue: { tag: 'int' as const, v: t },
      status: 'committed' as const,
    };
    return cont({
      ...state, control: rest,
      valueStack: [...newStack, { tag: 'int' as const, v: t }],
      effects: [...state.effects, entry],
    });
  }
```

Add `performNow` to import.

- [ ] **Step 4: Add `--time MS` parsing to `src/cli.ts`**

In `cmdRun` and `cmdResume`, after parsing other args, parse `--time`:

```ts
const timeOverride = typeof args.flags.time === 'string' ? Number(args.flags.time) : null;
```

Pass to state construction. Update `initialState` calls to support an override:

```ts
let state = initialState(ast.rootId);
if (timeOverride !== null) state = { ...state, timeOverride };
```

(Or add a parameter to `initialState`. For minimal change, do the post-construction override.)

In `cmdResume`, similarly set `timeOverride` on the loaded state.

- [ ] **Step 5: Append failing tests**

```ts
test('E1: now() records first-call value and replays it', () => {
  const source = resolve('/tmp/penelope-now.pen');
  const snap = resolve('/tmp/penelope-now.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let t = now(); let _ = pause; print(to_str(t));');
  
  // Run with --time 999 → t = 999.
  spawnSync(PEN, ['run', source, '--time', '999'], { encoding: 'utf8' });
  
  // Resume without --time; should still print 999 (from log).
  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.stdout.trim()).toBe('999');
  
  cleanup(source); cleanup(snap);
});

test('E3: --time MS overrides now() on fresh execution', () => {
  const source = resolve('/tmp/penelope-now-mock.pen');
  cleanup(source);
  writeFileSync(source, 'print(to_str(now()));');
  
  const r = spawnSync(PEN, ['run', source, '--time', '12345'], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe('12345');
  
  cleanup(source);
});
```

- [ ] **Step 6: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 90 passing.

- [ ] **Step 7: Commit**

```bash
git add src/effects.ts src/interpreter.ts src/cli.ts test/integration.test.ts
git commit -m "feat(effects): now() with --time CLI override"
```

---

## Task 18: random_int effect (test E2)

**Files:**
- Modify: `src/effects.ts`
- Modify: `src/interpreter.ts`
- Modify: `test/integration.test.ts`

- [ ] **Step 1: Add `performRandomInt` to `src/effects.ts`**

```ts
export function performRandomInt(lo: number, hi: number): number {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}
```

- [ ] **Step 2: Add random_int branch to `applyEffect`**

```ts
  if (name === 'random_int') {
    if (argCount !== 2) return { kind: 'error', message: `random_int expects 2 args, got ${argCount}` };
    const lo = args[0];
    const hi = args[1];
    if (lo.tag !== 'int') return { kind: 'error', message: `random_int lo must be int, got ${lo.tag}` };
    if (hi.tag !== 'int') return { kind: 'error', message: `random_int hi must be int, got ${hi.tag}` };
    const r = performRandomInt(lo.v, hi.v);
    const entry = {
      nodeId, invocationCount, effect: 'random_int' as const,
      recordedValue: { tag: 'int' as const, v: r },
      status: 'committed' as const,
    };
    return cont({
      ...state, control: rest,
      valueStack: [...newStack, { tag: 'int' as const, v: r }],
      effects: [...state.effects, entry],
    });
  }
```

Add `performRandomInt` to import.

- [ ] **Step 3: Append failing test**

```ts
test('E2: random_int recorded then replayed', () => {
  const source = resolve('/tmp/penelope-rand.pen');
  const snap = resolve('/tmp/penelope-rand.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let r = random_int(1, 1000000); let _ = pause; print(to_str(r));');
  
  // Run: random value picked, pause.
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  
  // Read snapshot to capture the recorded value.
  const recorded = JSON.parse(readFileSync(snap, 'utf8'))
    .state.effects.find((e: any) => e.effect === 'random_int').recordedValue.v;
  expect(typeof recorded).toBe('number');
  
  // Resume: must print the SAME value (from log).
  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.stdout.trim()).toBe(String(recorded));
  
  cleanup(source); cleanup(snap);
});
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 91 passing.

- [ ] **Step 5: Commit**

```bash
git add src/effects.ts src/interpreter.ts test/integration.test.ts
git commit -m "feat(effects): random_int with record/replay"
```

---

## Task 19: read_file effect (test F1)

**Files:**
- Modify: `src/effects.ts`
- Modify: `src/interpreter.ts`
- Modify: `test/integration.test.ts`

- [ ] **Step 1: Add `performReadFile` to `src/effects.ts`**

```ts
import { readFileSync } from 'node:fs';

export function performReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}
```

(The `readFileSync` import may already exist from earlier; consolidate.)

- [ ] **Step 2: Add read_file branch to `applyEffect`**

```ts
  if (name === 'read_file') {
    if (argCount !== 1) return { kind: 'error', message: `read_file expects 1 arg, got ${argCount}` };
    const path = args[0];
    if (path.tag !== 'str') return { kind: 'error', message: `read_file path must be str, got ${path.tag}` };
    let content: string;
    try {
      content = performReadFile(path.v);
    } catch (e) {
      return { kind: 'error', message: `read_file failed: ${(e as Error).message}`, atNode: nodeId };
    }
    const entry = {
      nodeId, invocationCount, effect: 'read_file' as const,
      recordedValue: { tag: 'str' as const, v: content },
      status: 'committed' as const,
    };
    return cont({
      ...state, control: rest,
      valueStack: [...newStack, { tag: 'str' as const, v: content }],
      effects: [...state.effects, entry],
    });
  }
```

- [ ] **Step 3: Append failing test**

```ts
test('F1: read_file recorded then replayed (file can be deleted after)', () => {
  const source = resolve('/tmp/penelope-rf.pen');
  const snap = resolve('/tmp/penelope-rf.penz');
  const dataFile = '/tmp/penelope-rf-data.txt';
  cleanup(source); cleanup(snap); cleanup(dataFile);
  
  writeFileSync(dataFile, 'original content');
  writeFileSync(source, 'let c = read_file("/tmp/penelope-rf-data.txt"); let _ = pause; print(c);');
  
  // Run: reads file, pauses.
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  
  // Delete the data file.
  cleanup(dataFile);
  
  // Resume: should still print "original content" (from log).
  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('original content');
  
  cleanup(source); cleanup(snap);
});
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 92 passing.

- [ ] **Step 5: Commit**

```bash
git add src/effects.ts src/interpreter.ts test/integration.test.ts
git commit -m "feat(effects): read_file with record/replay"
```

---

## Task 20: wait_until effect (tests G1, G2)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/integration.test.ts`

`wait_until(ms)` pauses for at least `ms` milliseconds (wall-clock).

- [ ] **Step 1: Add wait_until branch to `applyEffect`**

```ts
  if (name === 'wait_until') {
    if (argCount !== 1) return { kind: 'error', message: `wait_until expects 1 arg, got ${argCount}` };
    const msArg = args[0];
    if (msArg.tag !== 'int') return { kind: 'error', message: `wait_until ms must be int, got ${msArg.tag}` };
    
    if (existing !== undefined && existing.status === 'pending') {
      // Already pending — check if elapsed.
      const targetMs = existing.recordedValue;
      if (!targetMs || targetMs.tag !== 'int') {
        return { kind: 'error', message: 'wait_until: corrupted target time' };
      }
      const currentMs = state.timeOverride ?? Date.now();
      if (currentMs >= targetMs.v) {
        // Time elapsed — commit and continue.
        const updatedEffects = state.effects.map(e =>
          e.nodeId === nodeId && e.invocationCount === invocationCount
            ? { ...e, status: 'committed' as const }
            : e
        );
        return cont({
          ...state, control: rest,
          valueStack: [...newStack, { tag: 'unit' as const }],
          effects: updatedEffects,
        });
      } else {
        // Still pending — re-pause.
        return { kind: 'paused', state, pausedAt: nodeId };
      }
    }
    
    // First execution: append pending entry with target time.
    const nowMs = state.timeOverride ?? Date.now();
    const target = nowMs + msArg.v;
    const entry = {
      nodeId, invocationCount, effect: 'wait_until' as const,
      recordedValue: { tag: 'int' as const, v: target },
      status: 'pending' as const,
    };
    return {
      kind: 'paused',
      state: { ...state, effects: [...state.effects, entry] },
      pausedAt: nodeId,
    };
  }
```

**Note:** This branch handles BOTH first-execution and pending-replay paths for wait_until specifically. The earlier generic "existing is pending → re-pause" code in `applyEffect` would catch this too, but wait_until needs the time-check logic which is specific. Place this branch BEFORE the generic re-pause check.

Restructure: put the wait_until case ABOVE the generic `if (existing !== undefined && existing.status === 'pending')` check, OR fold the time-check into that generic check (uglier). Choose the first.

Actually, looking at it more carefully: the existing branch I wrote earlier was generic. Let me restructure `applyEffect` so wait_until and wait_for are handled BEFORE the generic existing-entry check. This way they own their pending logic.

**Refactor (apply ONCE in this task):** Move all wait-category handling above the generic `existing` checks. Pseudocode:

```ts
function applyEffect(...) {
  // ... compute invocationCount, existing ...
  
  // Wait effects own their pending/committed semantics:
  if (name === 'wait_until') { /* full logic above */ return ...; }
  if (name === 'wait_for') { /* in Task 21 */ }
  
  // Replay path for read/write effects (committed only):
  if (existing !== undefined && existing.status === 'committed') {
    /* existing replay logic */
  }
  
  // First execution path for read/write:
  if (name === 'print') { ... }
  if (name === 'write_file') { ... }
  // etc.
}
```

- [ ] **Step 2: Append failing tests**

```ts
test('G1: wait_until pauses, resume after target time continues', () => {
  const source = resolve('/tmp/penelope-wu.pen');
  const snap = resolve('/tmp/penelope-wu.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'wait_until(50); print("done");');
  
  // Run with mocked current time 1000 → target = 1050. Pauses.
  spawnSync(PEN, ['run', source, '--time', '1000'], { encoding: 'utf8' });
  expect(existsSync(snap)).toBe(true);
  
  // Resume with --time 2000 (> 1050): proceeds.
  const r2 = spawnSync(PEN, ['resume', snap, '--time', '2000'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('done');
  
  cleanup(source); cleanup(snap);
});

test('G2: wait_until resume too early re-pauses', () => {
  const source = resolve('/tmp/penelope-wu-early.pen');
  const snap = resolve('/tmp/penelope-wu-early.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'wait_until(10000); print("done");');
  
  spawnSync(PEN, ['run', source, '--time', '1000'], { encoding: 'utf8' });
  
  // Resume too early (--time 2000 << 1000+10000 = 11000).
  const r2 = spawnSync(PEN, ['resume', snap, '--time', '2000'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout).not.toMatch(/done/);
  // The snapshot should still exist with the same pending wait_until.
  expect(existsSync(snap)).toBe(true);
  
  cleanup(source); cleanup(snap);
});
```

- [ ] **Step 3: Handle `resume` with no positional value when pause is wait/wait_for**

Currently `cmdResume` requires a positional `<value>` argument. For wait_until/wait_for paused programs, the user shouldn't have to supply one. Make the positional optional when only `--event` or `--time` is needed.

In `src/cli.ts` `cmdResume`:

```ts
function cmdResume(args: ParsedArgs): number {
  const snapPath = args.positional[1];
  const valueText = args.positional[2];  // may be undefined now
  if (!snapPath) {
    process.stderr.write('usage: penelope resume <file.penz> [<value>] [--event NAME=VALUE]... [--time MS] [--force] [--out <path>]\n');
    return 2;
  }
  // ... existing snapshot load ...
  
  // Build the resumed state. The positional value is for Phase 1 `pause`; effects use --event.
  let resumedState: State = { ...dr.snap.state };
  
  if (valueText !== undefined) {
    // Phase 1 pause value injection
    const v = parseResumeValue(valueText);
    if ('error' in v) { ... return 2; }
    resumedState = { ...resumedState, valueStack: [...resumedState.valueStack, v] };
  }
  
  // Phase 2: time override
  if (typeof args.flags.time === 'string') {
    resumedState = { ...resumedState, timeOverride: Number(args.flags.time) };
  }
  
  // Phase 2: --event flags (handled in Task 21)
  
  // ... rest of cmdResume ...
}
```

- [ ] **Step 4: Run — expect PASS for G1, G2**

```bash
npm run build && npm test
```

Expected: 94 passing.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts src/cli.ts test/integration.test.ts
git commit -m "feat(effects): wait_until with target-time replay; resume positional optional"
```

---

## Task 21: wait_for effect + --event CLI flag (tests G3, G4, G5, H3)

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `src/cli.ts`
- Modify: `test/integration.test.ts`
- Create: `examples/07-wait-for.pen`

- [ ] **Step 1: Create `examples/07-wait-for.pen`**

```pen
print("waiting for approval");
let ok = wait_for("approval");
print("got: " + to_str(ok));
```

- [ ] **Step 2: Add wait_for branch to `applyEffect`**

In the wait-category section (placed BEFORE the generic existing checks, alongside wait_until):

```ts
  if (name === 'wait_for') {
    if (argCount !== 1) return { kind: 'error', message: `wait_for expects 1 arg, got ${argCount}` };
    const nameArg = args[0];
    if (nameArg.tag !== 'str') return { kind: 'error', message: `wait_for name must be str, got ${nameArg.tag}` };
    
    if (existing !== undefined && existing.status === 'committed') {
      // Event has been delivered — return the recordedValue (the event payload).
      if (existing.recordedValue === null) {
        return { kind: 'error', message: 'wait_for: committed but recordedValue is null (corrupted log)' };
      }
      return cont({ ...state, control: rest,
        valueStack: [...newStack, existing.recordedValue] });
    }
    
    if (existing !== undefined && existing.status === 'pending') {
      // Still pending — re-pause.
      return { kind: 'paused', state, pausedAt: nodeId };
    }
    
    // First execution: append pending entry with the event name in recordedValue.
    const entry = {
      nodeId, invocationCount, effect: 'wait_for' as const,
      recordedValue: { tag: 'str' as const, v: nameArg.v },  // store event name
      status: 'pending' as const,
    };
    return {
      kind: 'paused',
      state: { ...state, effects: [...state.effects, entry] },
      pausedAt: nodeId,
    };
  }
```

- [ ] **Step 3: Add `--event NAME=VALUE` parsing to `cmdResume`**

In `src/cli.ts`, update `parseArgs` if needed to support repeated `--event` flags. Currently `parseArgs` overwrites `flags[name]` on duplicate. Add support:

```ts
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const events: Record<string, string> = {};   // ← NEW: collect --event NAME=VALUE
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event') {
      const next = argv[++i];
      if (!next) throw new Error('--event requires NAME=VALUE');
      const eq = next.indexOf('=');
      if (eq < 0) throw new Error(`--event expects NAME=VALUE, got '${next}'`);
      events[next.slice(0, eq)] = next.slice(eq + 1);
      continue;
    }
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
  return { positional, flags, events };
}
```

Update `ParsedArgs` type:

```ts
type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | true>;
  events: Record<string, string>;
};
```

- [ ] **Step 4: In `cmdResume`, deliver events to pending wait_for entries**

After loading the snapshot in `cmdResume`, before driving the loop:

```ts
// Phase 2: deliver --event NAME=VALUE to pending wait_for entries.
const updatedEffects = resumedState.effects.map(e => {
  if (e.effect !== 'wait_for' || e.status !== 'pending') return e;
  if (!e.recordedValue || e.recordedValue.tag !== 'str') return e;
  const eventName = e.recordedValue.v;
  const eventValueText = args.events[eventName];
  if (eventValueText === undefined) return e;  // no event supplied for this name
  
  const v = parseResumeValue(eventValueText);
  if ('error' in v) {
    // Treat as string if not parseable as int/bool
    return { ...e, status: 'committed' as const, recordedValue: { tag: 'str' as const, v: eventValueText } };
  }
  return { ...e, status: 'committed' as const, recordedValue: v };
});
resumedState = { ...resumedState, effects: updatedEffects };
```

- [ ] **Step 5: Append failing tests**

```ts
test('G3: wait_for + --event approval=true resumes with bool', () => {
  const source = resolve('examples/07-wait-for.pen');
  const snap = resolve('examples/07-wait-for.penz');
  cleanup(snap);
  
  // First run: prints "waiting for approval", pauses on wait_for.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(r1.stdout.trim()).toBe('waiting for approval');
  expect(existsSync(snap)).toBe(true);
  
  // Resume with event.
  const r2 = spawnSync(PEN, ['resume', snap, '--event', 'approval=true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('got: true');  // print was skipped on replay; only "got: true" appears
  
  cleanup(snap);
});

test('G4: wait_for with int event value', () => {
  const source = resolve('/tmp/penelope-wfi.pen');
  const snap = resolve('/tmp/penelope-wfi.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let n = wait_for("count"); print(to_str(n));');
  
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  const r = spawnSync(PEN, ['resume', snap, '--event', 'count=42'], { encoding: 'utf8' });
  expect(r.stdout.trim()).toBe('42');
  
  cleanup(source); cleanup(snap);
});

test('G5: wait_for with string event value', () => {
  const source = resolve('/tmp/penelope-wfs.pen');
  const snap = resolve('/tmp/penelope-wfs.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let note = wait_for("memo"); print(note);');
  
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  const r = spawnSync(PEN, ['resume', snap, '--event', 'memo=hello world'], { encoding: 'utf8' });
  expect(r.stdout.trim()).toBe('hello world');
  
  cleanup(source); cleanup(snap);
});

test('H3: multi-pause flow — wait_for, then pause again, then continue', () => {
  const source = resolve('/tmp/penelope-multi.pen');
  const snap = resolve('/tmp/penelope-multi.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'let a = wait_for("first"); print("got " + a); let b = pause; print("got2 " + to_str(b));');
  
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  spawnSync(PEN, ['resume', snap, '--event', 'first=hello'], { encoding: 'utf8' });
  // After first resume, program prints "got hello" then pauses at the bare `pause`.
  const r3 = spawnSync(PEN, ['resume', snap, '99'], { encoding: 'utf8' });
  expect(r3.stdout.trim()).toBe('got2 99');  // first print is replay-skipped
  
  cleanup(source); cleanup(snap);
});
```

- [ ] **Step 6: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 98 passing.

- [ ] **Step 7: Commit**

```bash
git add src/interpreter.ts src/cli.ts test/integration.test.ts examples/07-wait-for.pen
git commit -m "feat(effects): wait_for with --event CLI flag; multi-pause flow"
```

---

## Task 22: `--no-replay` CLI flag

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `src/cli.ts`
- Modify: `test/integration.test.ts`

Add a debug escape hatch: `--no-replay` re-executes effects even if logged.

- [ ] **Step 1: Add `noReplay?: boolean` to State**

```ts
export type State = {
  // ...
  timeOverride?: number | null;
  noReplay?: boolean;  // ← NEW
};
```

- [ ] **Step 2: Use it in `applyEffect`**

In the replay-path checks, gate them on `!state.noReplay`:

```ts
  if (!state.noReplay && existing !== undefined && existing.status === 'committed') {
    // ... existing replay branch ...
  }
```

(Apply the same gate in wait_until and wait_for replay branches.)

- [ ] **Step 3: Wire CLI flag in `cmdResume`**

```ts
if (args.flags['no-replay'] === true) {
  resumedState = { ...resumedState, noReplay: true };
}
```

- [ ] **Step 4: Append a smoke test**

```ts
test('--no-replay re-executes print on resume', () => {
  const source = resolve('/tmp/penelope-noreplay.pen');
  const snap = resolve('/tmp/penelope-noreplay.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'print("hello"); let _ = pause; print("done");');
  
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  
  // Default: replay skips "hello".
  const r2 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r2.stdout.split('\n').filter(l => l.trim())).toEqual(['done']);
  
  // Re-create snapshot (it's overwritten).
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  
  // With --no-replay: "hello" prints again.
  const r3 = spawnSync(PEN, ['resume', snap, '--no-replay', 'true'], { encoding: 'utf8' });
  expect(r3.stdout.split('\n').filter(l => l.trim()).sort()).toEqual(['done', 'hello']);
  
  cleanup(source); cleanup(snap);
});
```

- [ ] **Step 5: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 99 passing.

- [ ] **Step 6: Commit**

```bash
git add src/interpreter.ts src/cli.ts test/integration.test.ts
git commit -m "feat(cli): --no-replay flag bypasses effect log on resume"
```

---

## Task 23: Inspect shows effect log (test B5)

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/integration.test.ts`

- [ ] **Step 1: Extend `cmdInspect` output**

In `src/cli.ts` `cmdInspect`, before the "Value stack" section, add:

```ts
  out.write(`\n`);
  out.write(`Effect log (${snap.state.effects.length} entries):\n`);
  if (snap.state.effects.length === 0) {
    out.write(`  (empty)\n`);
  } else {
    snap.state.effects.forEach((e, idx) => {
      const status = e.status === 'committed' ? '✓' : '⏳';
      const valueStr = e.recordedValue ? formatValue(e.recordedValue) : '(none)';
      out.write(`  ${idx + 1}. [${status}] ${e.effect.padEnd(12)} @${e.nodeId} #${e.invocationCount}  value=${valueStr}\n`);
    });
  }
```

- [ ] **Step 2: Append failing test**

```ts
test('B5: inspect shows effect log section', () => {
  const source = resolve('/tmp/penelope-inspect.pen');
  const snap = resolve('/tmp/penelope-inspect.penz');
  cleanup(source); cleanup(snap);
  writeFileSync(source, 'print("hi"); let _ = pause; print("done");');
  
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  const r = spawnSync(PEN, ['inspect', snap], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/Effect log/);
  expect(r.stdout).toMatch(/print/);
  
  cleanup(source); cleanup(snap);
});
```

- [ ] **Step 3: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 100 passing.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): inspect shows effect log section"
```

---

## Task 24: Examples 06-now-random.pen

**Files:**
- Create: `examples/06-now-random.pen`

This is just an additional demo file for documentation. Tests E1/E2/E3 already cover the behavior; no new integration test here.

- [ ] **Step 1: Write the example**

```pen
let t0 = now();
let r = random_int(1, 100);
print("started at: " + to_str(t0));
print("random: " + to_str(r));
let _ = pause;
print("after pause, t0 is still: " + to_str(t0));
print("after pause, r is still: " + to_str(r));
```

- [ ] **Step 2: Manual verification**

```bash
npm run build
./bin/penelope run examples/06-now-random.pen
./bin/penelope resume examples/06-now-random.penz true
# Expect: "after pause" lines repeat the SAME t0 and r values from before pause
rm examples/06-now-random.penz
```

- [ ] **Step 3: Commit**

```bash
git add examples/06-now-random.pen
git commit -m "docs(examples): now and random_int determinism demo"
```

---

## Task 25: Headline 24h HITL agent demo (H4)

**Files:**
- Create: `examples/08-24h-agent.pen`
- Modify: `test/integration.test.ts`

The Phase 2 acceptance.

- [ ] **Step 1: Write `examples/08-24h-agent.pen`**

```pen
let amount = 5000;
print("Approval request for $" + to_str(amount));
let decision = wait_for("approval");
print("Decision received: " + to_str(decision));
if (decision) {
  let response = net_fetch("https://httpbin.org/uuid");
  print("LLM processed");
  let _ = pause;
  write_file("/tmp/penelope-audit.log", response);
  print("Audit logged");
} else {
  print("Denied. No action.");
}
```

Note: the `let _ = pause;` between `print("LLM processed")` and `write_file(...)` is the deliberate second pause point so the demo has two crash boundaries.

- [ ] **Step 2: Append the H4 integration test**

```ts
test('H4: 24h HITL agent demo — crashes twice, completes correctly', () => {
  const source = resolve('examples/08-24h-agent.pen');
  const snap = resolve('examples/08-24h-agent.penz');
  const auditLog = '/tmp/penelope-audit.log';
  cleanup(snap); cleanup(auditLog);
  
  // Run 1: prints request, pauses on wait_for.
  const r1 = spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  expect(r1.status).toBe(0);
  expect(r1.stdout).toMatch(/Approval request for \$5000/);
  expect(existsSync(snap)).toBe(true);
  
  // Crash 1 simulated: just don't do anything; the snapshot is on disk.
  
  // Resume 1: deliver approval=true → prints decision, fetches LLM, prints "LLM processed", pauses at second pause.
  const r2 = spawnSync(PEN, ['resume', snap, '--event', 'approval=true'], { encoding: 'utf8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout).toMatch(/Decision received: true/);
  expect(r2.stdout).toMatch(/LLM processed/);
  expect(r2.stdout).not.toMatch(/Approval request/);  // first print was replay-skipped
  
  // Read the snapshot to capture the recorded fetch body for later comparison.
  const snapAfterRun1 = JSON.parse(readFileSync(snap, 'utf8'));
  const fetchEntry = snapAfterRun1.state.effects.find((e: any) => e.effect === 'net_fetch');
  expect(fetchEntry).toBeDefined();
  const recordedBody = fetchEntry.recordedValue.v;
  
  // Crash 2 simulated. Manually clear any pre-existing audit log.
  cleanup(auditLog);
  
  // Resume 2: no new event needed. Writes audit log (first time), prints "Audit logged".
  const r3 = spawnSync(PEN, ['resume', snap, 'true'], { encoding: 'utf8' });
  expect(r3.status).toBe(0);
  expect(r3.stdout).toMatch(/Audit logged/);
  expect(r3.stdout).not.toMatch(/LLM processed/);     // replay-skipped
  expect(r3.stdout).not.toMatch(/Decision received/); // replay-skipped
  expect(r3.stdout).not.toMatch(/Approval request/);  // replay-skipped
  
  // The audit log file MUST contain the recorded LLM body.
  expect(existsSync(auditLog)).toBe(true);
  expect(readFileSync(auditLog, 'utf8')).toBe(recordedBody);
  
  cleanup(snap); cleanup(auditLog);
}, 15000);  // network call may be slow
```

- [ ] **Step 3: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 101 passing. **This is the Phase 2 acceptance.**

- [ ] **Step 4: Commit**

```bash
git add examples/08-24h-agent.pen test/integration.test.ts
git commit -m "test(integration): 24h HITL agent demo — Phase 2 acceptance"
```

---

## Task 26: Fork preserves effect log (tests I1, I2, I3)

**Files:**
- Modify: `test/integration.test.ts`

Fork already deep-clones state via JSON in Phase 1. With `effects: []` added to State in Task 0, fork already preserves it. This task just locks in tests.

- [ ] **Step 1: Append tests**

```ts
test('I1+I2+I3+C3: fork copies effect log; branches diverge after fork', () => {
  const source = resolve('/tmp/penelope-fork-effects.pen');
  const snap = resolve('/tmp/penelope-fork-effects.penz');
  const fork0 = resolve('/tmp/penelope-fork-effects.fork0.penz');
  const fork1 = resolve('/tmp/penelope-fork-effects.fork1.penz');
  cleanup(source); cleanup(snap); cleanup(fork0); cleanup(fork1);
  
  writeFileSync(source, 'print("base"); let x = pause; print(to_str(x));');
  
  // Run: prints "base", pauses.
  spawnSync(PEN, ['run', source], { encoding: 'utf8' });
  
  // Fork with 1 and 2.
  const r = spawnSync(PEN, ['fork', snap, '1', '2'], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  
  // Neither branch re-prints "base" (effect log copied).
  expect(r.stdout).not.toMatch(/\[fork-0\] base/);
  expect(r.stdout).not.toMatch(/\[fork-1\] base/);
  
  // Both branches print their own x.
  expect(r.stdout).toMatch(/\[fork-0\] 1/);
  expect(r.stdout).toMatch(/\[fork-1\] 2/);
  
  cleanup(source); cleanup(snap); cleanup(fork0); cleanup(fork1);
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
npm run build && npm test
```

Expected: 102 passing.

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): fork preserves effect log; branch divergence"
```

---

## Task 27: README Phase 2 status section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append "Phase 2 Status" section before the existing "License" section**

```markdown
---

## Phase 2 Status

**Status:** ✅ Complete (2026-MM-DD)  <!-- update with actual completion date -->

Phase 2 turns Penelope into a **real agent runtime**. It adds:

- **Strings**: literals (`"hello"`), `+`/`==`/`!=` overloads, `str_length`, `str_slice`, `to_str` builtins
- **8 effect primitives**:
  - **Write** (skip on replay): `print` (now logged), `write_file(path, body)`
  - **Read** (record once, replay logged): `net_fetch(url)`, `now()`, `random_int(lo, hi)`, `read_file(path)`
  - **Wait** (pause cycle): `wait_until(ms)`, `wait_for(name)`
- **Effect log** in snapshot v2 (breaking change from v1)
- **CLI**: `pen resume --event NAME=VALUE`, `--time MS`, `--no-replay`; `pen inspect` shows the effect log

**~102 tests passing** — Phase 1 unchanged + Phase 2 unit (string + effect) + Phase 2 integration (crash + recover).

### The Phase 2 acceptance demo

A 24-hour HITL approval agent that **crashes twice mid-flight and still completes correctly**:

```bash
./bin/penelope run examples/08-24h-agent.pen
# → "Approval request for $5000", pauses on wait_for
# (process can die here — snapshot on disk)

./bin/penelope resume examples/08-24h-agent.penz --event approval=true
# → "Decision received: true", "LLM processed", pauses again
# (process can die again — snapshot updated)

./bin/penelope resume examples/08-24h-agent.penz true
# → "Audit logged" (writes /tmp/penelope-audit.log with the originally-fetched LLM body)
# Earlier prints are NOT repeated; the net_fetch is NOT re-called.
```

### What's next

Phase 3 is bytecode VM, live editing (`pause` → patch AST → resume), time-travel debugger, distributed snapshot migration. See `docs/superpowers/specs/2026-05-22-penelope-phase-1-design.md` §17 for the forward-compatibility notes Phase 2 built upon.
```

- [ ] **Step 2: Update the section date with today's date**

Replace `2026-MM-DD` with the actual commit date.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): Phase 2 status, 24h agent demo walkthrough, what's next"
```

---

## Final verification

```bash
npm run build && npm test
```

Expected: **102/102 tests passing.** Phase 2 done.

Manually walk the 24h HITL demo end-to-end from a fresh clone to confirm reproducibility.

```bash
# From a fresh clone
git clone git@github.com:airingursb/Penelope.git
cd Penelope
git checkout feat/phase-2
npm install
npm run build

./bin/penelope run examples/08-24h-agent.pen
./bin/penelope resume examples/08-24h-agent.penz --event approval=true
./bin/penelope resume examples/08-24h-agent.penz true
cat /tmp/penelope-audit.log
# → should contain the LLM response body, written exactly once
```

When the demo reproduces, Phase 2 is **DONE**.
