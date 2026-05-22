# Penelope Phase 1 — Design Spec

**Date**: 2026-05-22
**Status**: Approved, ready for implementation planning
**Scope**: Phase 1 only. Phase 2-4 are referenced where they influence Phase 1 decisions, never as deliverables.

---

## 1. Goal

Build a tiny language with a hand-written lexer, recursive-descent parser, and tree-walking interpreter in TypeScript on Node, whose only special primitive is `pause`. Prove that execution can be paused, serialized to disk as JSON, and resumed in a separate process with full state intact.

**Success is binary**: the three acceptance demos in §11 must pass. Nothing else matters in Phase 1.

---

## 2. Foundational Axiom

> **Execution is data. A running program is a value.**

Every design decision below reinforces this. When in doubt during implementation, choose the option that makes execution-as-data more literally true.

---

## 3. Locked Decisions Summary

| # | Decision | Rationale |
|---|---|---|
| D1 | TypeScript + Node, no compilation to bytecode | Phase 1 is about proving the thesis, not performance |
| D2 | Hand-written lexer + recursive-descent parser | Learning project; no parser generators, no existing JS parsers |
| D3 | Evaluator: **step machine** (`step(state) → state`) | Literal implementation of "execution is data"; serialization free; scales to Phase 2 (effects) and Phase 3 (bytecode) |
| D4 | State is plain JS data (no closures, classes, symbols, Maps) | `JSON.stringify` works directly |
| D5 | AST nodes stored in a flat `Record<NodeId, ASTNode>` with ID refs | Avoids duplication; supports Phase 3 live editing |
| D6 | Snapshot **references** source by path + sha256, does **not** embed AST | Snapshots stay small; source remains the single source of truth |
| D7 | Parser assigns NodeIds deterministically (DFS counter) | Resume re-parses; same source must produce same IDs |
| D8 | Scopes stored in a flat `Record<ScopeId, Scope>` with parent ID refs | Enables fork via plain JSON cloning; matches lexical scoping semantics |
| D9 | Closures capture by `ScopeId`, not by value | Lexical scoping is reference-based; matches the data-only constraint |
| D10 | Snapshot file extension: **`.penz`** | Short, distinctive, paired with `.pen` source |
| D11 | Source file extension: **`.pen`** | Locked previously |
| D12 | Resume injects value by pushing onto `valueStack`, then stepping | Pause expression "evaluates to" the resume value naturally |
| D13 | Main CLI command: `penelope`, short alias `pen` | Full for docs/CI, alias for daily use |
| D14 | Subcommands: `run`, `resume`, `fork`, `inspect` | `inspect` is brand action — execution must be visible |
| D15 | Resume value supplied as positional CLI arg, required (no default) | Pause result must be explicit |
| D16 | Snapshot defaults to source dir, `<basename>.penz` | One-to-one with source |
| D17 | Resume overwrites snapshot by default | Linear execution; history is Phase 3 |
| D18 | Pause is exit code 0 (not an error) | Pause is a normal language state |
| D19 | Zero production dependencies | Only Node built-ins (`fs`, `path`, `crypto`, `child_process`) |
| D20 | Test framework: **Vitest** | Lightweight, native TS, no config gymnastics |

---

## 4. Language Surface

Phase 1 implements exactly the following. Anything not listed here is **out of scope** (§4.6 and §14).

### 4.1 Values

- `int` — JS `number`, integer arithmetic only (`/` truncates toward zero)
- `bool` — JS `boolean`
- `closure` — function value with captured scope (created by `fn(...) { ... }`)
- `unit` — the no-value value. A block with no trailing expression evaluates to unit. Programs as a whole have no value (they communicate via `print`).

### 4.2 Expressions

- Integer literals: `0`, `42`, `7` (lexer only accepts non-negative; for negatives use `0 - n`)
- Boolean literals: `true`, `false`
- Variable reference: `x`
- Binary operators: `+`, `-`, `*`, `/`, `<`, `>`, `<=`, `>=`, `==`, `!=`
- Function literal: `fn(x, y) { block }` — anonymous; to name one, bind via `let`
- Function call: `f(a, b)`
- `if (cond) { thenBlock } else { elseBlock }` — both branches required; evaluates to the value of the taken block. `cond` must be `bool` at runtime.
- `pause` — the special primitive (an expression that returns the value supplied at resume)

### 4.3 Blocks

A block is `{ stmt* expr? }`: zero or more statements, optionally followed by a trailing expression.

- If a trailing expression is present, the block's value is that expression's value.
- If no trailing expression, the block's value is `unit`.
- A block introduces its own lexical scope. `let`s inside the block are visible only inside it.

Blocks are not standalone expressions. They appear only as function bodies and as `if`/`else` branches.

### 4.4 Statements

Each statement ends with `;`.

- `let NAME = expr;` — bind `NAME` in the current scope
- `print(expr);` — write to stdout
- `expr;` — expression statement (value evaluated, then discarded)

No `return` keyword. The implicit return is the trailing expression of a function's body block.

No `fn` or `if` as statements. To define a named function: `let f = fn(...) { ... };`. To use an if for side effects only: as an ExprStmt — the unit-valued result is discarded.

### 4.5 Programs

A `.pen` file is a sequence of statements at top level. The global scope `s0` is the enclosing scope (no implicit block around the top level — top-level `let`s land in `s0`).

Programs as a whole have no return value. Their observable output is via `print`.

### 4.6 Out of Scope (Phase 1)

Strings, arrays, objects, records, references, type checking, modules, async/await, error handling syntax (`try/catch`), comments other than `//`, multi-line comments, escape sequences, `return` keyword, unary minus, named function declaration sugar (`fn name() {...}`).

---

## 5. Architecture

```
                        cli.ts
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
    lexer.ts          parser.ts         interpreter.ts ──► snapshot.ts
        │                 │                  │                 │
        └─────────────────┴────────►  ast.ts ◄─────────────────┘
                                  (types only, no runtime code)
```

Six modules. Single direction of dependency. No cycles.

| Module | Purpose | Public API |
|---|---|---|
| `ast.ts` | Pure type definitions | Type exports only |
| `lexer.ts` | Source → tokens | `tokenize(source: string): Token[]` |
| `parser.ts` | Tokens → AST | `parse(tokens: Token[]): ASTBundle` |
| `interpreter.ts` | State machine | `initialState(rootId): State`; `step(state, ast): StepResult` |
| `snapshot.ts` | (De)serialize state, verify hash | `serialize(snapshot): string`; `deserialize(json, source): Snapshot` |
| `cli.ts` | Entry point, subcommand dispatch | `main(argv: string[]): void` |

---

## 6. Data Flow

### 6.1 First-time run (`pen run foo.pen`)

```
foo.pen
   │
   ▼  fs.readFileSync
source: string
   │
   ▼  lexer.tokenize
Token[]
   │
   ▼  parser.parse  (deterministic NodeId assignment via DFS counter)
ASTBundle
   │
   ▼  interpreter.initialState(rootId)
State { control:[eval(rootId)], valueStack:[], scopes:{s0:globalScope}, currentScopeId:'s0', nextScopeIdCounter:1 }
   │
   ▼  while loop: state = step(state, ast)
   │
   ├─► 'done'    → exit 0
   ├─► 'paused'  → snapshot.serialize → write foo.penz → exit 0
   └─► 'error'   → print to stderr, exit 1
```

### 6.2 Resume (`pen resume foo.penz 5`)

```
foo.penz
   │
   ▼  fs.readFileSync, JSON.parse
{programPath, programHash, state, pausedAt, ...}
   │
   ▼  resolve programPath relative to .penz dir
   ▼  fs.readFileSync, sha256, compare to programHash
   ▼   (mismatch → error; --force overrides)
source: string
   │
   ▼  lexer.tokenize + parser.parse  (deterministic IDs match snapshot)
ASTBundle
   │
   ▼  parse "5" as Value → push onto state.valueStack
State'
   │
   ▼  same step loop as above
   ...
```

The critical observation: **resume is not a special path in the interpreter**. It only differs from `run` at the CLI layer (how state is constructed). The step function knows nothing about pause/resume; it just consumes the control stack until empty or paused.

---

## 7. The Step Machine

### 7.1 State type

```ts
type State = {
  control: ControlInstr[];        // pending instructions, top of stack = next to execute
  valueStack: Value[];            // intermediate computation results
  scopes: Record<ScopeId, Scope>; // all live scopes
  currentScopeId: ScopeId;        // which scope `eval` of a Var resolves against
  nextScopeIdCounter: number;     // monotonic counter for new ScopeIds
};

type Scope = {
  parentId: ScopeId | null;
  bindings: Record<string, Value>;
};

type Value =
  | { tag: 'int',     v: number }
  | { tag: 'bool',    v: boolean }
  | { tag: 'closure', paramNames: string[], bodyId: NodeId, capturedScopeId: ScopeId }
  | { tag: 'unit' };

type ControlInstr =
  | { op: 'eval',           nodeId: NodeId }
  | { op: 'applyBin',       binOp: BinOp }
  | { op: 'applyPrint' }
  | { op: 'bindLet',        name: string }              // pop value, bind in currentScope
  | { op: 'branch',         thenId: NodeId, elseId: NodeId }  // pop bool, eval correct branch
  | { op: 'invoke',         argCount: number }          // closure + args on valueStack
  | { op: 'popScope',       restoreScopeId: ScopeId }   // restore prior currentScopeId
  | { op: 'pushUnit' }                                  // push unit onto valueStack
  | { op: 'discard' };                                  // drop top of valueStack (for ExprStmt)

// Note: there is no explicit pushScope op. Block and invoke allocate a new
// scope as part of their step transition (atomically with queueing further
// instructions). popScope is the corresponding restoration instr.
```

Every field is plain JSON-serializable data. No functions, no symbols, no Maps, no class instances.

### 7.2 Step function

```ts
type StepResult =
  | { kind: 'continue', state: State }
  | { kind: 'done',     finalValue: Value | null }
  | { kind: 'paused',   state: State, pausedAt: NodeId }
  | { kind: 'error',    message: string, atNode?: NodeId };

function step(state: State, ast: ASTBundle): StepResult {
  if (state.control.length === 0) {
    return { kind: 'done',
             finalValue: state.valueStack[state.valueStack.length - 1] ?? null };
  }
  
  const instr = state.control[state.control.length - 1];
  const rest = state.control.slice(0, -1);
  
  switch (instr.op) {
    case 'eval': {
      const node = ast.nodes[instr.nodeId];
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
          // Push in reverse: applyBin runs after both operands evaluated
          return cont({ ...state, control: [
            ...rest,
            { op: 'applyBin', binOp: node.op },
            { op: 'eval', nodeId: node.rightId },
            { op: 'eval', nodeId: node.leftId },
          ]});
        
        case 'Let':
          return cont({ ...state, control: [
            ...rest,
            { op: 'bindLet', name: node.name },
            { op: 'eval', nodeId: node.valueId },
          ]});
        
        case 'If':
          return cont({ ...state, control: [
            ...rest,
            { op: 'branch', thenId: node.thenId, elseId: node.elseId },
            { op: 'eval', nodeId: node.condId },
          ]});
        
        case 'Fn': {
          const closure: Value = { tag: 'closure',
            paramNames: node.params, bodyId: node.bodyId,
            capturedScopeId: state.currentScopeId };
          return cont({ ...state, control: rest,
            valueStack: [...state.valueStack, closure] });
        }
        
        case 'Call':
          // Push: invoke after callee and args all evaluated, left-to-right
          return cont({ ...state, control: [
            ...rest,
            { op: 'invoke', argCount: node.argIds.length },
            ...node.argIds.slice().reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
            { op: 'eval', nodeId: node.calleeId },
          ]});
        
        case 'Print':
          return cont({ ...state, control: [
            ...rest,
            { op: 'applyPrint' },
            { op: 'eval', nodeId: node.argId },
          ]});
        
        case 'Pause':
          return { kind: 'paused',
                   state: { ...state, control: rest },
                   pausedAt: node.id };
        
        case 'Program':
          return cont({ ...state, control: [
            ...rest,
            ...node.stmtIds.slice().reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
          ]});
        
        case 'ExprStmt':
          return cont({ ...state, control: [
            ...rest,
            { op: 'discard' },
            { op: 'eval', nodeId: node.exprId },
          ]});
        
        case 'Block': {
          // Allocate the block's own scope, queue its body, queue scope restoration
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
              ...node.stmtIds.slice().reverse().map(id => ({ op: 'eval' as const, nodeId: id })),
            ],
            scopes: { ...state.scopes,
              [newScopeId]: { parentId: state.currentScopeId, bindings: {} }},
            currentScopeId: newScopeId,
            nextScopeIdCounter: state.nextScopeIdCounter + 1,
          });
        }
      }
    }
    
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
    
    case 'branch': {
      const cond = state.valueStack[state.valueStack.length - 1];
      if (cond.tag !== 'bool')
        return { kind: 'error', message: `if condition must be bool, got ${cond.tag}` };
      return cont({ ...state, control: [
        ...rest,
        { op: 'eval', nodeId: cond.v ? instr.thenId : instr.elseId },
      ], valueStack: state.valueStack.slice(0, -1) });
    }
    
    case 'invoke':
      return invokeClosure(state, rest, instr.argCount);
    
    case 'popScope':
      return cont({ ...state, control: rest, currentScopeId: instr.restoreScopeId });
    
    case 'pushUnit':
      return cont({ ...state, control: rest,
        valueStack: [...state.valueStack, { tag: 'unit' }] });
    
    case 'discard':
      return cont({ ...state, control: rest,
        valueStack: state.valueStack.slice(0, -1) });
  }
}

function cont(state: State): StepResult {
  return { kind: 'continue', state };
}
```

Helper functions (`applyBinOp`, `invokeClosure`, `lookup`, `formatValue`) follow the same plain-data style. `invokeClosure` is the only non-trivial one — it allocates a fresh ScopeId, populates it with parameter bindings under the captured scope as parent, queues `popScope` after the body.

### 7.3 Immutability

Every transition copies state (`{...state}`, `slice()`, spread). No in-place mutation. This is what lets fork work for free: `fork(state)` is `[{...state}, {...state}]`, deep-enough because spread + slice on the records produces independent copies, and inner objects (Scope, Value) are never mutated in place.

---

## 8. Snapshot Format

### 8.1 The `.penz` file

```ts
type Snapshot = {
  version: 1;                       // schema version, reserved for Phase 2
  programPath: string;              // relative to the .penz file's directory
  programHash: string;              // "sha256:<hex>" of source bytes
  pausedAt: NodeId;                 // which Pause node triggered this snapshot
  pausedAtMs: number;               // Date.now() at pause, for audit
  state: State;                     // the entire execution state (§7.1)
};
```

JSON-stringified to disk, two-space indented for readability (debug-friendly; size is irrelevant for Phase 1).

### 8.2 Serialization

```ts
function serialize(snap: Snapshot): string {
  return JSON.stringify(snap, null, 2);
}
```

That's it. No custom encoder. If `JSON.stringify` can't handle some field, that field is illegal in Phase 1 — which is exactly the constraint that keeps state plain data.

### 8.3 Deserialization + hash check

```ts
function deserialize(
  json: string,
  resolveSource: (path: string) => string,
  options: { force?: boolean } = {}
): { snap: Snapshot, source: string } | { error: string } {
  let snap: Snapshot;
  try { snap = JSON.parse(json); }
  catch (e) { return { error: 'snapshot is corrupted (invalid JSON)' }; }
  
  if (snap.version !== 1)
    return { error: `unknown snapshot version: ${snap.version}` };
  
  let source: string;
  try { source = resolveSource(snap.programPath); }
  catch (e) { return { error: `cannot find source file: ${snap.programPath}` }; }
  
  const actualHash = 'sha256:' + sha256(source);
  if (actualHash !== snap.programHash && !options.force)
    return { error: `source has changed since pause (expected ${snap.programHash}, got ${actualHash}). Use --force to override.` };
  
  return { snap, source };
}
```

### 8.4 Determinism guarantee

Parser must assign NodeIds via a single rule: **depth-first traversal of the AST as it's being built, with a monotonic counter**. The first node ever created (the program root, or a literal, depending on parsing order) gets `n0`, the next `n1`, and so on. Two `parse(tokenize(source))` calls on identical source must produce identical NodeId assignments.

This is what makes resume's re-parse safe.

---

## 9. CLI

### 9.1 `penelope run <file.pen>` (alias `pen run`)

Parse, evaluate, run until done, paused, or error.

- Default snapshot output: `<source_dir>/<source_basename>.penz`
- `--out <path>` overrides
- `--quiet` suppresses metadata output (prints from program still go through)

Exit codes: §9.5.

### 9.2 `penelope resume <file.penz> <value>` (alias `pen resume`)

Load snapshot, resolve source, verify hash, inject value, continue.

- `<value>` is positional and required. Parsed as int if `^-?\d+$`, as bool if `true`/`false`. Otherwise error.
- `--source <path>` overrides the snapshot's recorded source path
- `--force` skips hash check
- `--out <path>` writes any subsequent snapshot to this path (default: overwrite the input `.penz`)

### 9.3 `penelope fork <file.penz> <v1> <v2>`

Load the snapshot, deep-clone state twice, inject `v1` into one and `v2` into the other, run both to completion or pause.

- `--out1 <path>` / `--out2 <path>` for subsequent snapshots from each branch
- Default branch output: `<basename>.fork0.penz` / `<basename>.fork1.penz`
- Prefix stdout with `[fork-0]` / `[fork-1]` to disambiguate

### 9.4 `penelope inspect <file.penz>`

Pretty-print snapshot contents. Required output:

- Pause location (file, line, column, NodeId)
- Source hash status (✓ matches / ✗ stale / ? source missing)
- Time paused (absolute + relative)
- All live scopes with bindings
- The control stack (top → bottom, decoded for readability — `eval n7 (Pause)` not just `{op:'eval',nodeId:'n7'}`)
- The value stack

This command exists not for utility but for *worldview transmission*. The first time a user `inspect`s a snapshot, they understand what Penelope is.

### 9.5 Exit codes

| Code | Meaning |
|---|---|
| 0 | Program completed (ran to end, or paused successfully — pause is not an error) |
| 1 | Runtime error during evaluation |
| 2 | CLI argument error |
| 3 | Snapshot load error (corrupt, missing source, hash mismatch) |

### 9.6 Argv parsing

Hand-written, no dependencies. ~50 lines. The CLI is small enough that yargs/commander would be overhead, not help.

---

## 10. Testing Strategy

### 10.1 Unit tests (Vitest, one file per source module)

- **`lexer.test.ts`** — token sequences for keywords (`let`, `if`, `else`, `fn`, `pause`, `print`, `true`, `false`), operators, integer literals, identifiers, whitespace, line comments, EOF.
- **`parser.test.ts`** — AST shape for representative programs. Critical: **NodeId determinism test** (parse the same source twice, assert identical `nodes` keys and contents).
- **`interpreter.test.ts`** — `step()` correctness per `ControlInstr`. Arithmetic, comparisons, scope lookup including capture across function calls, let bindings, branching. Runtime errors fire at the right node.
- **`snapshot.test.ts`** — `JSON.parse(serialize(snap)) === snap` (deep equal). Hash mismatch error. Corrupt JSON error. Version mismatch error.

### 10.2 Integration tests (cross-process, the heart of Phase 1)

`test/integration.test.ts` uses `child_process.spawnSync` to invoke the CLI in fresh Node processes.

```ts
test('demo 1: top-level pause survives across processes', () => {
  cleanupSnapshot('examples/01-toplevel-pause.penz');
  
  const r1 = spawnSync('node', ['dist/cli.js', 'run', 'examples/01-toplevel-pause.pen'], { encoding: 'utf-8' });
  expect(r1.status).toBe(0);
  expect(existsSync('examples/01-toplevel-pause.penz')).toBe(true);
  
  const r2 = spawnSync('node', ['dist/cli.js', 'resume', 'examples/01-toplevel-pause.penz', '5'], { encoding: 'utf-8' });
  expect(r2.status).toBe(0);
  expect(r2.stdout.trim()).toBe('15');
});

test('demo 2: nested-function pause preserves outer frame', () => {
  // Source: fn outer() { let a = 1; fn inner() { let b = pause; return a + b }; return inner() }
  //         print(outer())
  // Resume with b=41 → prints 42
});

test('demo 3: fork produces two independent futures', () => {
  // Run a program that pauses; fork with 10 and 20; expect two distinct outputs
});
```

Each demo also has a corresponding committed `.pen` file in `examples/` so a user can reproduce manually.

### 10.3 What counts as passing

`vitest run` exits 0. Period. Nothing else is a Phase 1 success metric.

---

## 11. Acceptance Demos

The `.pen` files committed to `examples/`:

### 11.1 `01-toplevel-pause.pen`

```pen
let x = 10;
let y = pause;
print(x + y);
```

Run 1: writes `01-toplevel-pause.penz`, exit 0.
Resume with `5`: prints `15`, exit 0.

### 11.2 `02-nested-pause.pen`

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

Run 1: writes `02-nested-pause.penz`, exit 0.
Resume with `41`: prints `42`, exit 0.

Proves the call-stack and closure-capture-across-pause case. Note the implicit-return style: `a + b` (no `;`) is the trailing expression of `inner`'s body block; `inner()` is the trailing expression of `outer`'s body block. The lexically captured `a` is correctly visible to `inner` after resume because `inner`'s closure captured the scope ID where `a = 1` lives, and that scope survives in the snapshot's `scopes` map.

### 11.3 `03-fork.pen`

```pen
let base = 100;
let x = pause;
print(base + x);
```

Run 1: writes `03-fork.penz`.
`pen fork 03-fork.penz 5 10`: prints two lines, `[fork-0] 105` and `[fork-1] 110`.

Proves snapshot is a value (re-usable from the same paused point).

---

## 12. Runtime Errors

Comprehensive list. The interpreter emits a `{ kind: 'error', message, atNode? }` result; the CLI prints to stderr and exits 1.

| Trigger | Message |
|---|---|
| Type mismatch in binary op | `cannot apply '+' to int and bool` |
| Division by zero | `division by zero` |
| Call non-callable | `not callable: <value-summary>` |
| Wrong arg count | `expected N args, got M` |
| Undefined variable | `undefined variable '<name>'` |
| `if` condition non-bool | `if condition must be bool, got <tag>` |
| Resume value unparseable | (CLI error, exit 2) `cannot parse '<value>' as int or bool` |
| Source hash mismatch | (CLI error, exit 3) `source has changed since pause. Use --force to override.` |
| Source file missing | (CLI error, exit 3) `cannot find source file: <path>. Use --source to override.` |
| Snapshot JSON corrupt | (CLI error, exit 3) `snapshot is corrupted (invalid JSON)` |
| Snapshot version unknown | (CLI error, exit 3) `unknown snapshot version: <n>` |

Error messages should be plain English, lowercase first letter, no period, include node ID or line/col where available.

---

## 13. File Layout

```
Penelope/
├── CLAUDE.md                       (gitignored)
├── README.md
├── .gitignore
├── package.json
├── tsconfig.json
├── vitest.config.ts
│
├── src/
│   ├── ast.ts                      (types only)
│   ├── lexer.ts
│   ├── parser.ts
│   ├── interpreter.ts              (State, step, helpers)
│   ├── snapshot.ts
│   └── cli.ts                      (argv parsing, subcommand dispatch, main)
│
├── test/
│   ├── lexer.test.ts
│   ├── parser.test.ts
│   ├── interpreter.test.ts
│   ├── snapshot.test.ts
│   └── integration.test.ts         (the three acceptance demos)
│
├── examples/
│   ├── 01-toplevel-pause.pen
│   ├── 02-nested-pause.pen
│   └── 03-fork.pen
│
├── bin/
│   └── penelope                    (#!/usr/bin/env node ; require dist/cli.js)
│
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-05-22-penelope-phase-1-design.md   (this file)
```

`package.json` `bin` field registers both `penelope` and `pen` pointing to the same launcher.

---

## 14. Out of Scope (explicit, to prevent creep)

- Strings, arrays, objects, references
- Comments other than `//` line comments
- Negative integer literals (use `0 - n` if needed)
- Unary minus, `return` keyword, named function declaration sugar
- Type checking, type inference, type annotations
- Effect / capability system (Phase 2)
- Modules, imports
- async / await (`pause` is Penelope's async)
- Bytecode, VM, optimization (Phase 3)
- Live editing, time-travel debugging (Phase 3)
- LLM integration
- Standard library beyond `print`
- I/O beyond stdout
- Multi-snapshot history / branching beyond `fork`
- GC of unreachable scopes (rely on Node's GC; snapshot keeps them all alive)

---

## 15. Implementation Order

Each step is one Conventional Commit. Tests must be green before moving on.

1. `chore: bootstrap typescript and vitest`
2. `feat(ast): define AST node types and value types`
3. `feat(lexer): tokenize the Phase 1 language surface`
4. `test(lexer): unit tests for tokens, comments, keywords`
5. `feat(parser): recursive descent parser with deterministic NodeIds`
6. `test(parser): unit tests including NodeId determinism`
7. `feat(interpreter): step function for pure subset (no pause yet)`
8. `test(interpreter): arithmetic, scope, closures, runtime errors`
9. `feat(snapshot): serialize/deserialize with sha256 verification`
10. `test(snapshot): roundtrip, hash mismatch, corruption, version`
11. `feat(interpreter): pause as a control instruction`
12. `feat(cli): run subcommand`
13. `feat(cli): resume subcommand with value injection`
14. `feat(cli): fork subcommand`
15. `feat(cli): inspect subcommand`
16. `feat(examples): three acceptance demo .pen files`
17. `test(integration): demo 1 — top-level pause`
18. `test(integration): demo 2 — nested-function pause`
19. `test(integration): demo 3 — fork`
20. `docs(readme): Phase 1 completion section`

20 commits. Could be fewer if some unit-test commits get folded into their feature commit. The order is the important part, not the count.

---

## 16. Open Questions (resolve during implementation, not now)

| ID | Question | Default |
|---|---|---|
| O1 | `print` formatting of closures? | `<fn>` (no further detail) |
| O2 | `print` formatting of `unit`? | `()` (Rust-style) |
| O3 | Should `inspect` show the full source file path or just the basename? | Both: basename in headline, full path in detail |
| O4 | When `fork` has uneven outputs (one branch completes, other pauses again), how to report? | Each branch's outcome reported independently with `[fork-N]` prefix; if both pause, both snapshots written |
| O5 | `step()`'s `done.finalValue` for programs (which by spec have no return value) | Always `null` for valid Phase 1 programs (all statements clear the value stack). Field is reserved for Phase 2 inspection. |

These are minor and can be settled by the implementer without re-opening the design.

---

## 17. Phase 2 Forward-Compatibility Notes

Decisions in this spec that exist specifically because Phase 2 (effect system) will need them:

- `version: 1` on snapshots → bump to 2 when effect log is added
- `State` is a single object, easy to add an `effectLog: EffectEntry[]` field
- `step` function is pure → effect tracking is "log before performing"; replay knows what to skip
- `applyPrint` is the only side-effect-out point in Phase 1 → Phase 2 will route this through an effect handler

Decisions intentionally **not** made now (will be revisited in Phase 2):

- How effect identity is tracked across forks
- How replay distinguishes "already-fired" from "needs-firing" effects
- Whether `@pure` / `@effect` annotations are syntax or comments

---

## 18. Phase 1 Done Criteria

When and only when all of the following are true, Phase 1 is complete:

1. `vitest run` exits 0 with all unit and integration tests passing.
2. The three acceptance demos are reproducible by hand from a fresh clone:
   ```
   git clone <repo>
   cd Penelope
   npm install
   npm run build
   ./bin/penelope run examples/01-toplevel-pause.pen
   ./bin/penelope resume examples/01-toplevel-pause.penz 5
   # → prints 15
   ```
3. README has a "Phase 1 Status" section documenting completion and the three demos.
4. Commit history follows Conventional Commits throughout, with all tests passing at each commit.

Nothing else is required for Phase 1 to be called done.
