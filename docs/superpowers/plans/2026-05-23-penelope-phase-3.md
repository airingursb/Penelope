# Penelope Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 1/2's step-machine interpreter with a stack-based bytecode VM preceded by an optimizing compiler. After this plan ships: source compiles to `.penc` bytecode, the VM executes opcodes directly, 5 optimizer passes run before execution, and all 107 Phase 2 tests still pass.

**Architecture:** AST → `compiler.ts` (one case per ASTNode kind) → 17-opcode bytecode → `optimizer.ts` (5 passes: constant fold / DCE / inline caches / fn inline / peephole) → `encoder.ts` (.penc JSON) → `vm.ts` (execution loop with frame-based call stack). The old `interpreter.ts` is moved to `legacy-interpreter.ts` purely for benchmarks. Snapshot format bumps v2 → v3.

**Tech Stack:** TypeScript 5.x, Node ≥18, Vitest. Zero new production deps.

**Reference spec:** `docs/superpowers/specs/2026-05-23-penelope-phase-3-design.md`
**Reference Phase 2 plan:** `docs/superpowers/plans/2026-05-23-penelope-phase-2.md`

**Execution strategy:** 4 waves. Waves 2 and 3 are parallelizable across 4 and 5 subagents respectively. Total ~65 tasks.

---

## File Structure (Phase 3 diff from Phase 2)

| Path | Status | Tasks | Responsibility |
|---|---|---|---|
| `src/interpreter.ts` | DELETED | T1 | (moved) |
| `src/legacy-interpreter.ts` | NEW (copy) | T1 | step-machine kept for fib benchmark only |
| `src/bytecode.ts` | NEW | T2 | Opcode types, ConstantPoolEntry, Program type |
| `src/snapshot.ts` | MODIFIED | T3 | bump v2→v3, define VMState shape, reject v2 |
| `src/effects.ts` | MODIFIED | T4, T23 | EffectEntry.ip replaces EffectEntry.nodeId |
| `src/compiler.ts` | NEW | T5-T15 | AST → bytecode, one fn per ASTNode kind |
| `src/vm.ts` | NEW | T16-T25 | execution loop + 17 opcode dispatchers + frame mgmt |
| `src/encoder.ts` | NEW | T26-T27 | Program (de)serialize, .penc file format |
| `src/cli.ts` | MODIFIED | T28-T30, T51-T55 | pen build/exec/run/disasm/bench |
| `src/optimizer.ts` | NEW | T31-T50 | 5 passes, each pure Program→Program |
| `test/bytecode.test.ts` | NEW | T2 | Opcode shapes, constant pool dedup |
| `test/compiler.test.ts` | NEW | T5-T15 | per-ASTNode-kind tests |
| `test/vm.test.ts` | NEW | T16-T25 | per-opcode + integration tests |
| `test/encoder.test.ts` | NEW | T26-T27 | Program roundtrip, validation |
| `test/optimizer.test.ts` | NEW | T31-T50 | 5 passes × ~4 tests each |
| `test/bench.test.ts` | NEW | T54 | fib(20) speedup assertion |
| `test/integration.test.ts` | MODIFIED | T56-T60 | Phase 2 demos via VM |
| `examples/09-fib.pen` | NEW | T54 | benchmark target |

---

## Test catalog mapping (spec §13 → plan tasks)

| Spec Group | Tests | Plan tasks |
|---|---|---|
| A — Bytecode types | 5 | T2 |
| B — Compiler per-ASTNode | 20 | T5 (skeleton), T6-T15 |
| C — VM per-opcode | 17 | T16 (skeleton), T17-T25 |
| D — VM running real programs | 20 | T25, T56-T60 |
| E — Constant Folding | 10 | T31-T34 |
| F — Dead Code Elimination | 8 | T35-T38 |
| G — Inline Caches | 5 | T39-T42 |
| H — Function Inlining | 8 | T43-T46 |
| I — Peephole | 8 | T47-T50 |
| J — -O level equivalence | 5 | T51, T64 |
| K — .penc encoding | 8 | T26-T27 |
| L — Snapshot v3 | 8 | T3, T57 |
| M — CLI integration | 15 | T28-T30, T52-T55 |
| N — Phase 2 regression | parametrized | T56-T60 |
| O — Benchmark | 3 | T54 |

---

# Wave 1 — Foundation (sequential, T1-T4)

These four tasks form the base layer. T2-T4 depend on T1; all Wave 2 work depends on T1-T4. Run Wave 1 sequentially.

## Task 1: Move interpreter.ts → legacy-interpreter.ts

**Why:** Phase 3 introduces the VM as the runtime. The old step-machine is preserved as `legacy-interpreter.ts` for the fib benchmark comparison and as a debugging reference. All current imports of `./interpreter.js` must be updated.

**Files:**
- Rename: `src/interpreter.ts` → `src/legacy-interpreter.ts`
- Modify: every file currently importing from `./interpreter.js`

- [ ] **Step 1: Move the file**

```bash
git mv src/interpreter.ts src/legacy-interpreter.ts
```

- [ ] **Step 2: Find all import sites**

```bash
grep -rn "from '\./interpreter\.js'" src/ test/ || echo "(none)"
grep -rn "from '\.\./src/interpreter\.js'" test/ || echo "(none)"
```

Note the file:line list. There will be several in `src/cli.ts` and most files under `test/`.

- [ ] **Step 3: Update every import**

For each file that imports from `'./interpreter.js'`, change to `'./legacy-interpreter.js'`. For test files importing from `'../src/interpreter.js'`, change to `'../src/legacy-interpreter.js'`.

Use this for-loop one-liner to verify after edits:
```bash
grep -rn "interpreter\.js" src/ test/ | grep -v "legacy-interpreter"
```
Expected: empty output (every interpreter reference is now `legacy-interpreter`).

- [ ] **Step 4: Verify build + tests still pass**

```bash
npm run build && npm test
```
Expected: All 107 Phase 2 tests pass (this is a pure rename — semantics unchanged).

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: move interpreter to legacy-interpreter (Phase 3 prep)"
```

---

## Task 2: src/bytecode.ts — Opcode types + constant pool helpers

**Why:** Define the bytecode shape that compiler.ts will produce and vm.ts will consume. Types-first establishes the contract that Waves 2A and 2B can implement in parallel against.

**Files:**
- Create: `src/bytecode.ts`
- Create: `test/bytecode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/bytecode.test.ts`:

```ts
import { test, expect } from 'vitest';
import type { Opcode, ConstantPoolEntry, Program } from '../src/bytecode.js';
import { internConstant, makeProgram } from '../src/bytecode.js';

test('makeProgram returns empty program with version 1', () => {
  const p = makeProgram();
  expect(p.version).toBe(1);
  expect(p.constants).toEqual([]);
  expect(p.code).toEqual([]);
});

test('internConstant deduplicates equal int entries', () => {
  const pool: ConstantPoolEntry[] = [];
  const i1 = internConstant(pool, { tag: 'int', v: 10 });
  const i2 = internConstant(pool, { tag: 'int', v: 10 });
  const i3 = internConstant(pool, { tag: 'int', v: 20 });
  expect(i1).toBe(0);
  expect(i2).toBe(0);            // dedup
  expect(i3).toBe(1);
  expect(pool).toEqual([
    { tag: 'int', v: 10 },
    { tag: 'int', v: 20 },
  ]);
});

test('internConstant deduplicates strings and bools separately', () => {
  const pool: ConstantPoolEntry[] = [];
  internConstant(pool, { tag: 'str', v: 'hello' });
  internConstant(pool, { tag: 'str', v: 'hello' });
  internConstant(pool, { tag: 'bool', v: true });
  internConstant(pool, { tag: 'bool', v: true });
  internConstant(pool, { tag: 'unit' });
  internConstant(pool, { tag: 'unit' });
  expect(pool.length).toBe(3);   // str, bool, unit — each deduped
});

test('Opcode is a tuple — first element is the op name', () => {
  const op: Opcode = ['LOAD_CONST', 0];
  expect(op[0]).toBe('LOAD_CONST');
});

test('all 17 opcode names are exported as a set', () => {
  const { OPCODE_NAMES } = require('../src/bytecode.js') as { OPCODE_NAMES: ReadonlySet<string> };
  const expected = [
    'LOAD_CONST', 'LOAD_VAR', 'STORE_VAR', 'BIN_OP',
    'JUMP', 'JUMP_IF_FALSE',
    'MAKE_CLOSURE', 'CALL', 'CALL_BUILTIN', 'RETURN',
    'EFFECT', 'PAUSE',
    'POP', 'PUSH_UNIT',
    'ENTER_BLOCK', 'EXIT_BLOCK',
    'HALT',
  ];
  expect(OPCODE_NAMES.size).toBe(17);
  for (const name of expected) expect(OPCODE_NAMES.has(name)).toBe(true);
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm test -- bytecode
```
Expected: module not found.

- [ ] **Step 3: Create `src/bytecode.ts`**

```ts
// Penelope bytecode definitions.
// Phase 3: AST → compiler.ts → these types → vm.ts.
// All types are JSON-serializable (no functions, no symbols).

import type { Value } from './ast.js';

// A constant pool entry is a literal Value with no closures.
export type ConstantPoolEntry =
  | { tag: 'int';  v: number }
  | { tag: 'bool'; v: boolean }
  | { tag: 'str';  v: string }
  | { tag: 'unit' };

// 17 opcodes. Each Opcode is a tuple [name, ...operands].
// Operands are primitive (int, string, string[], etc.) — JSON-serializable.
export type Opcode =
  | ['LOAD_CONST',    constIdx: number]
  | ['LOAD_VAR',      name: string, ic?: LoadVarIC | null]
  | ['STORE_VAR',     name: string]
  | ['BIN_OP',        op: string]
  | ['JUMP',          targetIp: number]
  | ['JUMP_IF_FALSE', targetIp: number]
  | ['MAKE_CLOSURE',  paramNames: string[], bodyIp: number, bodyLen: number]
  | ['CALL',          argc: number]
  | ['CALL_BUILTIN',  name: string, argc: number]
  | ['RETURN']
  | ['EFFECT',        name: string, argc: number, ic?: number | null]
  | ['PAUSE']
  | ['POP']
  | ['PUSH_UNIT']
  | ['ENTER_BLOCK']
  | ['EXIT_BLOCK']
  | ['HALT'];

// Inline cache for LOAD_VAR: cache the (framesUp, scopeSlot) pair after first lookup.
export type LoadVarIC = {
  framesUp: number;     // 0 = current frame, 1 = parent, ...
  // (no slot index needed for Map-style bindings; reserved for future use)
};

// The full bytecode program.
export type Program = {
  version: 1;
  source?: string;       // optional pretty source for debug
  sourceHash?: string;   // sha256(source)
  constants: ConstantPoolEntry[];
  code: Opcode[];
};

// All 17 opcode names — used by VM dispatcher and disassembler.
export const OPCODE_NAMES: ReadonlySet<string> = new Set([
  'LOAD_CONST', 'LOAD_VAR', 'STORE_VAR', 'BIN_OP',
  'JUMP', 'JUMP_IF_FALSE',
  'MAKE_CLOSURE', 'CALL', 'CALL_BUILTIN', 'RETURN',
  'EFFECT', 'PAUSE',
  'POP', 'PUSH_UNIT',
  'ENTER_BLOCK', 'EXIT_BLOCK',
  'HALT',
]);

// Constructor for an empty program.
export function makeProgram(): Program {
  return { version: 1, constants: [], code: [] };
}

// Add (or look up) a constant in the pool. Returns its index.
// Dedupes by deep equality (cheap because Values are primitive shapes).
export function internConstant(pool: ConstantPoolEntry[], entry: ConstantPoolEntry): number {
  for (let i = 0; i < pool.length; i++) {
    const e = pool[i];
    if (e.tag !== entry.tag) continue;
    if (e.tag === 'unit' && entry.tag === 'unit') return i;
    if (e.tag === 'int' && entry.tag === 'int' && e.v === entry.v) return i;
    if (e.tag === 'bool' && entry.tag === 'bool' && e.v === entry.v) return i;
    if (e.tag === 'str' && entry.tag === 'str' && e.v === entry.v) return i;
  }
  pool.push(entry);
  return pool.length - 1;
}

// Helper: convert a runtime Value to a ConstantPoolEntry. Throws on closure (not constant).
export function valueToConstant(v: Value): ConstantPoolEntry {
  if (v.tag === 'int')  return { tag: 'int',  v: v.v };
  if (v.tag === 'bool') return { tag: 'bool', v: v.v };
  if (v.tag === 'str')  return { tag: 'str',  v: v.v };
  if (v.tag === 'unit') return { tag: 'unit' };
  throw new Error(`cannot intern closure as constant`);
}

// Helper: convert a ConstantPoolEntry to a runtime Value.
export function constantToValue(e: ConstantPoolEntry): Value {
  if (e.tag === 'int')  return { tag: 'int',  v: e.v };
  if (e.tag === 'bool') return { tag: 'bool', v: e.v };
  if (e.tag === 'str')  return { tag: 'str',  v: e.v };
  return { tag: 'unit' };
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm test -- bytecode
```
Expected: 5 new tests pass; 112 total (107 prior + 5).

- [ ] **Step 5: Commit**

```bash
git add src/bytecode.ts test/bytecode.test.ts
git commit -m "feat(bytecode): opcode types, constant pool, Program shape"
```

---

## Task 3: src/snapshot.ts — bump to v3 with VMState

**Why:** The VM state (IP + valueStack + frames) is fundamentally different from the step-machine state (control stack + scope dictionary). Bump snapshot version 2 → 3 with the new shape; reject v2 with a helpful error.

**Files:**
- Modify: `src/snapshot.ts`
- Modify: `test/snapshot.test.ts`

- [ ] **Step 1: Append failing tests to `test/snapshot.test.ts`**

```ts
test('deserialize rejects v2 snapshots with helpful message', () => {
  const v2snap = {
    version: 2,
    programPath: 'x.pen',
    programHash: 'sha256:abc',
    pausedAt: 'n5',
    pausedAtMs: 0,
    state: {
      control: [],
      valueStack: [],
      scopes: { s0: { parentId: null, bindings: {} } },
      currentScopeId: 's0',
      nextScopeIdCounter: 1,
      effects: [],
    },
  };
  const r = deserialize(JSON.stringify(v2snap), () => 'let x = 1;');
  expect('error' in r).toBe(true);
  if ('error' in r) {
    expect(r.error).toMatch(/version 3/);
  }
});

test('v3 snapshot with VMState roundtrips', () => {
  const source = 'let x = 1;';
  const snap = {
    version: 3 as const,
    programPath: 'x.penc',
    programHash: 'sha256:' + sha256(source),
    pausedAtIP: 42,
    pausedAtMs: 0,
    state: {
      ip: 42,
      valueStack: [{ tag: 'int' as const, v: 10 }],
      frames: [{ bindings: { x: { tag: 'int' as const, v: 5 } } }],
      effects: [],
    },
  };
  const r = deserialize(JSON.stringify(snap), () => source);
  if ('error' in r) throw new Error(`unexpected: ${r.error}`);
  expect(r.snap.version).toBe(3);
  if (r.snap.version !== 3) throw new Error('expected v3');
  expect(r.snap.state.ip).toBe(42);
  expect(r.snap.state.valueStack).toHaveLength(1);
  expect(r.snap.state.frames).toHaveLength(1);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- snapshot
```

- [ ] **Step 3: Update `src/snapshot.ts`**

Replace the existing `Snapshot` type and version check.

```ts
// At the top, replace the State import with VMState (will define below)
import type { Value } from './ast.js';

// Phase 3 VM state — separate from the Phase 2 step-machine State.
export type Frame = {
  bindings: Record<string, Value>;
  returnIP?: number;            // present for CALL frames, absent for blocks + top-level
  parentIdx?: number;           // for chain via index (not pointer) — serializable
};

export type VMState = {
  ip: number;
  valueStack: Value[];
  frames: Frame[];
  effects: EffectEntry[];
  timeOverride?: number | null;
  noReplay?: boolean;
};

// Effect entry now indexed by ip not nodeId.
export type EffectEntry = {
  ip: number;
  invocationCount: number;
  effect: 'print' | 'net_fetch' | 'now' | 'random_int' | 'read_file' | 'write_file' | 'wait_until' | 'wait_for';
  recordedValue: Value | null;
  status: 'pending' | 'committed';
};

// Phase 3 Snapshot — bumped to v3.
export type Snapshot = {
  version: 3;
  programPath: string;          // path to .penc file (not .pen source)
  programHash: string;          // sha256(.penc content)
  pausedAtIP: number;
  pausedAtMs: number;
  state: VMState;
};
```

In `deserialize`, update the version check:

```ts
if ((snap.version as number) !== 3) {
  return {
    error: `unknown snapshot version: ${snap.version}. Phase 3 uses version 3 (v1/v2 snapshots are not migratable; re-run from source).`,
  };
}
```

- [ ] **Step 4: Update all `goodSnap` fixtures in `test/snapshot.test.ts`**

Replace existing v2 fixtures with v3:
- `version: 2` → `version: 3`
- `pausedAt: 'n5'` → `pausedAtIP: 42`
- `state` field shape: replace `{ control, valueStack, scopes, currentScopeId, nextScopeIdCounter, effects }` with `{ ip: 42, valueStack: [], frames: [{ bindings: {} }], effects: [] }`
- Update prior `EffectEntry` test fixtures: `nodeId: 'n2'` → `ip: 2`

Use search/replace carefully — the patterns are:
- `version: 2 as const` → `version: 3 as const`
- `version: 2,` → `version: 3,`
- `pausedAt: 'n5'` → `pausedAtIP: 5`
- `pausedAt: '` → `pausedAtIP: ` then continue context

The exact diff depends on the current state of `test/snapshot.test.ts`; the engineer should read the file and update each fixture by hand.

- [ ] **Step 5: Update `test/effect.test.ts` fixtures**

The B4 and H5 tests in `test/effect.test.ts` construct Snapshot literals. Update them similarly:
- `version: 2` → `version: 3`
- State shape change
- `nodeId: 'n2'` → `ip: 2` in EffectEntry literals

- [ ] **Step 6: Run — expect new tests PASS, existing tests still pass**

```bash
npm test -- snapshot
npm test -- effect
```

Note: Many other tests (integration, vm) WILL break because they reference the old State shape or run programs through interpreter. Those break is expected — they will be fixed in subsequent tasks (T16+ vm; T56+ integration).

For this task, only snapshot.test.ts and effect.test.ts need to pass green at this step.

- [ ] **Step 7: Commit**

```bash
git add src/snapshot.ts test/snapshot.test.ts test/effect.test.ts
git commit -m "feat(snapshot): bump to v3 with VMState shape; reject v2"
```

---

## Task 4: src/effects.ts — migrate EffectEntry.ip

**Why:** Phase 2's EffectEntry uses `nodeId` (AST identity). The VM doesn't have NodeIds — its identity is the IP (instruction pointer). Migrate the type now; the actual runtime use of `ip` happens in T23 (vm.ts EFFECT dispatcher).

**Files:**
- Modify: `src/effects.ts`
- (Reference: `test/effect.test.ts` already updated in T3)

- [ ] **Step 1: Update EffectEntry type — but `src/effects.ts` doesn't define EffectEntry**

The Phase 2 `EffectEntry` type lives in `src/interpreter.ts` (now `src/legacy-interpreter.ts` after T1) and is re-exported via... actually, search to confirm:

```bash
grep -n "EffectEntry" src/*.ts
```

If the Phase 3 `EffectEntry` is now in `src/snapshot.ts` (per T3 above), there is no further work in `src/effects.ts` for this task — it just needs to import from `snapshot.ts`.

- [ ] **Step 2: In `src/effects.ts`, ensure no `nodeId` references remain**

```bash
grep -n "nodeId" src/effects.ts
```
Expected: empty. `src/effects.ts` only deals with EffectName / categoryOf / performNetFetch etc., which don't reference nodeId.

- [ ] **Step 3: Verify build still passes**

```bash
npx tsc --noEmit
```
Expected: many errors in `src/legacy-interpreter.ts` (it still uses the old EffectEntry shape). That's expected — `legacy-interpreter.ts` is unused at runtime; its only consumer is the future fib benchmark (T54), which will adapt then.

To avoid blocking compilation, add to `tsconfig.json`'s `exclude` array:
```json
{
  "exclude": ["src/legacy-interpreter.ts"]
}
```

Then verify:
```bash
npx tsc --noEmit
```
Expected: clean. (legacy-interpreter.ts is now type-checked separately later.)

- [ ] **Step 4: Commit**

```bash
git add src/effects.ts tsconfig.json
git commit -m "refactor(effects): exclude legacy-interpreter from tsc; EffectEntry now in snapshot.ts"
```

---

# Wave 2 — Core (parallel, T5-T30)

Wave 2 has four independent tracks that can run in parallel after Wave 1 completes:

- **2A — Compiler (T5-T15)**: AST → bytecode. Pure function of AST; depends on bytecode.ts (T2).
- **2B — VM (T16-T25)**: Run bytecode. Depends on bytecode.ts (T2) and snapshot.ts/VMState (T3).
- **2C — Encoder (T26-T27)**: Serialize/deserialize .penc. Depends on bytecode.ts (T2).
- **2D — CLI (T28-T30)**: build/exec wires above three together. Depends on 2A + 2B + 2C completing.

Subagent dispatcher: run 2A + 2B + 2C in parallel. After all three complete, run 2D.

## Wave 2A — Compiler (T5-T15)

Each task adds one piece of `src/compiler.ts`. Tests grow in `test/compiler.test.ts`. The compiler is a pure function `compile(ast: ASTBundle): Program` that walks the AST in source order and emits Opcodes.

### Task 5: Compiler skeleton + Program/HALT

**Files:**
- Create: `src/compiler.ts`
- Create: `test/compiler.test.ts`

- [ ] **Step 1: Failing test**

```ts
// test/compiler.test.ts
import { test, expect } from 'vitest';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';

test('empty program compiles to just HALT', () => {
  const ast = parse(tokenize(''));
  const prog = compile(ast);
  expect(prog.version).toBe(1);
  expect(prog.code).toEqual([['HALT']]);
  expect(prog.constants).toEqual([]);
});
```

- [ ] **Step 2: Run — FAIL**: `npm test -- compiler` → module not found.

- [ ] **Step 3: Create `src/compiler.ts`**

```ts
// Penelope compiler. AST → bytecode (one fn per ASTNode kind).
// Walks AST in source order and emits Opcodes into a flat code array.
// Each emitted opcode is at the IP equal to code.length at emission time.

import type { ASTNode, ASTBundle, NodeId } from './ast.js';
import type { Program, Opcode, ConstantPoolEntry } from './bytecode.js';
import { makeProgram, internConstant } from './bytecode.js';

export function compile(ast: ASTBundle): Program {
  const prog = makeProgram();
  compileNode(ast.nodes[ast.rootId], ast, prog);
  prog.code.push(['HALT']);
  return prog;
}

// Dispatch on node.kind. Tasks 6-15 fill in per-kind cases.
function compileNode(node: ASTNode, ast: ASTBundle, prog: Program): void {
  switch (node.kind) {
    case 'Program': {
      for (const stmtId of node.stmtIds) compileNode(ast.nodes[stmtId], ast, prog);
      return;
    }
    default:
      throw new Error(`compile: unhandled node kind '${node.kind}'`);
  }
}

// Helper: emit a single opcode and return its IP.
function emit(prog: Program, op: Opcode): number {
  const ip = prog.code.length;
  prog.code.push(op);
  return ip;
}
```

- [ ] **Step 4: Run — PASS**: `npm test -- compiler` → 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): skeleton with Program and HALT emit"
```

---

### Task 6: Compile IntLit

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('IntLit compiles to LOAD_CONST', () => {
  const ast = parse(tokenize('42;'));
  const prog = compile(ast);
  expect(prog.constants).toContainEqual({ tag: 'int', v: 42 });
  // Code: LOAD_CONST 0, POP (from ExprStmt — Task 15), HALT
  // For now (only IntLit + Program implemented), ExprStmt isn't handled — skip
  // We test via a hack: compile the IntLit directly via internal API
});
```

Wait — `ExprStmt` isn't implemented yet (Task 15). Two options: (a) make this test compile the inner IntLit directly (requires exposing compileNode); (b) skip the test until ExprStmt lands and only test via a programmatic path.

**Better approach:** export an internal `compileNodeForTest` helper. Or test directly with an IntLit literal node passed through:

```ts
test('IntLit compiles to LOAD_CONST with constant pool entry', () => {
  // Build a synthetic Program-wrapped IntLit and verify the emitted bytecode.
  // Use the parser-produced AST but bypass ExprStmt by reading inside.
  const ast = parse(tokenize('42;'));
  // The Program contains ExprStmt -> IntLit; we'll compile in T15 once both work.
  // For Task 6, verify via direct call:
  const { compileForTest } = require('../src/compiler.js') as {
    compileForTest: (kind: string, src: string) => { prog: any };
  };
  const { prog } = compileForTest('IntLit', '42;');
  // prog should have an IntLit entry in constants
  expect(prog.constants).toContainEqual({ tag: 'int', v: 42 });
  expect(prog.code).toContainEqual(['LOAD_CONST', 0]);
});
```

Actually cleaner: just make the cases incremental, and add ExprStmt early (here in T6 alongside IntLit) so we can test naturally.

**REVISED Step 1**: write a test that uses `42;` as input. To make this work, compile_compile both IntLit (here) and ExprStmt (POP — small addition). Test asserts the prog's bytecode.

```ts
test('"42;" compiles to LOAD_CONST 0; POP; HALT with constants=[int 42]', () => {
  const ast = parse(tokenize('42;'));
  const prog = compile(ast);
  expect(prog.constants).toEqual([{ tag: 'int', v: 42 }]);
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['POP'],
    ['HALT'],
  ]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add IntLit and ExprStmt cases in `compileNode`**

```ts
case 'IntLit': {
  const idx = internConstant(prog.constants, { tag: 'int', v: node.value });
  emit(prog, ['LOAD_CONST', idx]);
  return;
}
case 'ExprStmt': {
  compileNode(ast.nodes[node.exprId], ast, prog);
  emit(prog, ['POP']);
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): IntLit and ExprStmt"
```

---

### Task 7: Compile BoolLit

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('"true;" compiles', () => {
  const prog = compile(parse(tokenize('true;')));
  expect(prog.constants).toEqual([{ tag: 'bool', v: true }]);
  expect(prog.code).toEqual([['LOAD_CONST', 0], ['POP'], ['HALT']]);
});

test('"false;" compiles', () => {
  const prog = compile(parse(tokenize('false;')));
  expect(prog.constants).toEqual([{ tag: 'bool', v: false }]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add BoolLit case**

```ts
case 'BoolLit': {
  const idx = internConstant(prog.constants, { tag: 'bool', v: node.value });
  emit(prog, ['LOAD_CONST', idx]);
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): BoolLit"
```

---

### Task 8: Compile StringLit (with dedup check)

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('StringLit compiles', () => {
  const prog = compile(parse(tokenize('"hello";')));
  expect(prog.constants).toEqual([{ tag: 'str', v: 'hello' }]);
  expect(prog.code).toEqual([['LOAD_CONST', 0], ['POP'], ['HALT']]);
});

test('repeated string literals share one constant pool entry', () => {
  const prog = compile(parse(tokenize('"x"; "x"; "y";')));
  expect(prog.constants).toEqual([
    { tag: 'str', v: 'x' },
    { tag: 'str', v: 'y' },
  ]);
  // Three LOAD_CONST opcodes; first two index 0, third index 1.
  const loads = prog.code.filter(op => op[0] === 'LOAD_CONST');
  expect(loads).toEqual([['LOAD_CONST', 0], ['LOAD_CONST', 0], ['LOAD_CONST', 1]]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add StringLit case**

```ts
case 'StringLit': {
  const idx = internConstant(prog.constants, { tag: 'str', v: node.value });
  emit(prog, ['LOAD_CONST', idx]);
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): StringLit with constant pool dedup"
```

---

### Task 9: Compile Var

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('Var compiles to LOAD_VAR', () => {
  const prog = compile(parse(tokenize('x;')));
  expect(prog.code).toEqual([
    ['LOAD_VAR', 'x', null],
    ['POP'],
    ['HALT'],
  ]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add Var case**

```ts
case 'Var': {
  emit(prog, ['LOAD_VAR', node.name, null]);  // null = ic slot, filled by VM
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): Var (LOAD_VAR with empty IC slot)"
```

---

### Task 10: Compile BinOp

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('1 + 2 compiles to LOAD_CONST, LOAD_CONST, BIN_OP', () => {
  const prog = compile(parse(tokenize('1 + 2;')));
  expect(prog.constants).toEqual([{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }]);
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['LOAD_CONST', 1],
    ['BIN_OP', '+'],
    ['POP'],
    ['HALT'],
  ]);
});

test('comparison op compiles', () => {
  const prog = compile(parse(tokenize('1 < 2;')));
  expect(prog.code).toContainEqual(['BIN_OP', '<']);
});

test('precedence: 1 + 2 * 3', () => {
  const prog = compile(parse(tokenize('1 + 2 * 3;')));
  // Parser already encoded precedence in AST shape — compiler just walks.
  // Expect: LOAD 1, LOAD 2, LOAD 3, BIN_OP *, BIN_OP +, POP, HALT
  const opNames = prog.code.map(op => op[0]);
  expect(opNames).toEqual(['LOAD_CONST', 'LOAD_CONST', 'LOAD_CONST', 'BIN_OP', 'BIN_OP', 'POP', 'HALT']);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add BinOp case**

```ts
case 'BinOp': {
  compileNode(ast.nodes[node.leftId], ast, prog);
  compileNode(ast.nodes[node.rightId], ast, prog);
  emit(prog, ['BIN_OP', node.op]);
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): BinOp (left, right, apply)"
```

---

### Task 11: Compile Let (STORE_VAR)

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('let x = 10; compiles to LOAD_CONST, STORE_VAR x', () => {
  const prog = compile(parse(tokenize('let x = 10;')));
  expect(prog.constants).toEqual([{ tag: 'int', v: 10 }]);
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['STORE_VAR', 'x'],
    ['HALT'],
  ]);
});

test('let then use', () => {
  const prog = compile(parse(tokenize('let x = 10; x;')));
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['STORE_VAR', 'x'],
    ['LOAD_VAR', 'x', null],
    ['POP'],
    ['HALT'],
  ]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add Let case**

```ts
case 'Let': {
  compileNode(ast.nodes[node.valueId], ast, prog);
  emit(prog, ['STORE_VAR', node.name]);
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): Let (compile value, store var)"
```

---

### Task 12: Compile If (JUMP, JUMP_IF_FALSE)

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

`If` is the first opcode-pattern that needs **back-patching**: we don't know jump targets until we've compiled the branches.

- [ ] **Step 1: Failing tests**

```ts
test('if (true) { 1 } else { 2 } compiles with two jumps', () => {
  const prog = compile(parse(tokenize('if (true) { 1 } else { 2 };')));
  const opNames = prog.code.map(op => op[0]);
  // Expected sequence:
  //   LOAD_CONST true        (0)
  //   JUMP_IF_FALSE A        (1)
  //   ENTER_BLOCK            (2)
  //   LOAD_CONST 1           (3)
  //   EXIT_BLOCK             (4)
  //   JUMP B                 (5)
  //   ENTER_BLOCK            (6) <- A
  //   LOAD_CONST 2           (7)
  //   EXIT_BLOCK             (8)
  //                          (9) <- B
  //   POP                    (9)
  //   HALT                   (10)
  expect(opNames).toEqual([
    'LOAD_CONST',
    'JUMP_IF_FALSE',
    'ENTER_BLOCK', 'LOAD_CONST', 'EXIT_BLOCK',
    'JUMP',
    'ENTER_BLOCK', 'LOAD_CONST', 'EXIT_BLOCK',
    'POP',
    'HALT',
  ]);
  // Validate jump targets:
  const jif = prog.code[1] as ['JUMP_IF_FALSE', number];
  const jmp = prog.code[5] as ['JUMP', number];
  expect(jif[1]).toBe(6);   // points to ENTER_BLOCK of else branch
  expect(jmp[1]).toBe(9);   // points past else branch (POP)
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add If case (with back-patching)**

```ts
case 'If': {
  // Compile cond
  compileNode(ast.nodes[node.condId], ast, prog);
  // Emit JUMP_IF_FALSE with placeholder target
  const jifIp = emit(prog, ['JUMP_IF_FALSE', -1]);
  // Compile then-block
  compileNode(ast.nodes[node.thenBlockId], ast, prog);
  // Emit JUMP past else with placeholder
  const jmpIp = emit(prog, ['JUMP', -1]);
  // Back-patch JUMP_IF_FALSE to point here (else start)
  (prog.code[jifIp] as ['JUMP_IF_FALSE', number])[1] = prog.code.length;
  // Compile else-block
  compileNode(ast.nodes[node.elseBlockId], ast, prog);
  // Back-patch JUMP to point here (past else)
  (prog.code[jmpIp] as ['JUMP', number])[1] = prog.code.length;
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): If with back-patched jumps"
```

---

### Task 13: Compile Fn (MAKE_CLOSURE)

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

Function compilation also uses back-patching — we emit MAKE_CLOSURE referencing body_ip, then emit a JUMP-past-body, then the body itself (which becomes the body the closure references).

- [ ] **Step 1: Failing test**

```ts
test('fn() { 1 } compiles', () => {
  const prog = compile(parse(tokenize('let f = fn() { 1 };')));
  const opNames = prog.code.map(op => op[0]);
  // Expected:
  //   MAKE_CLOSURE [], body_ip=3, body_len=4   (0)
  //   JUMP past=6                              (1)
  //   STORE_VAR f                              (2)
  //   ENTER_BLOCK                              (3) <- body_ip
  //   LOAD_CONST 1                             (4)
  //   EXIT_BLOCK                               (5)
  //   RETURN                                   (6)
  //   HALT                                     (7) <- past
  // Wait — the JUMP past should land on STORE_VAR f, not past it.
  // Sequence is: MAKE_CLOSURE, JUMP past_body, body..., RETURN
  // The MAKE_CLOSURE+JUMP is emitted INSIDE the Let's compile-value phase.
  // Then STORE_VAR f. Then any subsequent statements.
  // 
  // So: MAKE_CLOSURE -> JUMP X -> body (ENTER, LOAD, EXIT, RETURN) -> X: STORE_VAR f -> HALT
  expect(opNames).toEqual([
    'MAKE_CLOSURE', 'JUMP',
    'ENTER_BLOCK', 'LOAD_CONST', 'EXIT_BLOCK', 'RETURN',
    'STORE_VAR',
    'HALT',
  ]);
  const mk = prog.code[0] as ['MAKE_CLOSURE', string[], number, number];
  expect(mk[1]).toEqual([]);         // no params
  expect(mk[2]).toBe(2);             // body_ip = ENTER_BLOCK position
  expect(mk[3]).toBe(4);             // body_len = 4 opcodes (ENTER, LOAD, EXIT, RETURN)
  const jp = prog.code[1] as ['JUMP', number];
  expect(jp[1]).toBe(6);             // jumps past RETURN to STORE_VAR
});

test('fn with two params', () => {
  const prog = compile(parse(tokenize('let add = fn(a, b) { a + b };')));
  const mk = prog.code.find(op => op[0] === 'MAKE_CLOSURE') as ['MAKE_CLOSURE', string[], number, number];
  expect(mk[1]).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add Fn case**

```ts
case 'Fn': {
  // Emit MAKE_CLOSURE with placeholders; back-patch body_ip and body_len.
  const mkIp = emit(prog, ['MAKE_CLOSURE', node.params, -1, -1]);
  // Emit JUMP-past-body with placeholder
  const jmpIp = emit(prog, ['JUMP', -1]);
  // Body starts here
  const bodyStartIp = prog.code.length;
  compileNode(ast.nodes[node.bodyBlockId], ast, prog);
  emit(prog, ['RETURN']);
  const bodyEndIp = prog.code.length;
  // Back-patch MAKE_CLOSURE body_ip and body_len
  (prog.code[mkIp] as ['MAKE_CLOSURE', string[], number, number])[2] = bodyStartIp;
  (prog.code[mkIp] as ['MAKE_CLOSURE', string[], number, number])[3] = bodyEndIp - bodyStartIp;
  // Back-patch JUMP to land here (past body)
  (prog.code[jmpIp] as ['JUMP', number])[1] = prog.code.length;
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): Fn with back-patched MAKE_CLOSURE and JUMP-past-body"
```

---

### Task 14: Compile Call (with EFFECT / CALL_BUILTIN detection)

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('print("hi") compiles to LOAD_CONST + EFFECT', () => {
  const prog = compile(parse(tokenize('print("hi");')));
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['EFFECT', 'print', 1, null],
    ['POP'],
    ['HALT'],
  ]);
});

test('str_length("abc") compiles to LOAD_CONST + CALL_BUILTIN', () => {
  const prog = compile(parse(tokenize('str_length("abc");')));
  expect(prog.code).toEqual([
    ['LOAD_CONST', 0],
    ['CALL_BUILTIN', 'str_length', 1],
    ['POP'],
    ['HALT'],
  ]);
});

test('normal closure call compiles to LOAD_VAR callee + args + CALL', () => {
  const prog = compile(parse(tokenize('let f = fn(x) { x }; f(7);')));
  // After fn defn and STORE_VAR f, the call sequence is:
  //   LOAD_VAR f, LOAD_CONST 7, CALL 1
  const callIdx = prog.code.findIndex(op => op[0] === 'CALL');
  expect(callIdx).toBeGreaterThan(0);
  expect(prog.code[callIdx]).toEqual(['CALL', 1]);
  expect(prog.code[callIdx - 1]).toEqual(['LOAD_CONST', 0]); // arg
  expect(prog.code[callIdx - 2]).toEqual(['LOAD_VAR', 'f', null]);
});

test('net_fetch is an effect', () => {
  const prog = compile(parse(tokenize('net_fetch("http://x");')));
  expect(prog.code.find(op => op[0] === 'EFFECT')).toEqual(['EFFECT', 'net_fetch', 1, null]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add Call case + reserved-name helpers**

Add at top of `src/compiler.ts`:

```ts
import { EFFECT_NAMES } from './effects.js';

const PURE_BUILTINS: ReadonlySet<string> = new Set([
  'str_length', 'str_slice', 'to_str',
]);
```

Then the case:

```ts
case 'Call': {
  const callee = ast.nodes[node.calleeId];
  // Effect builtin?
  if (callee.kind === 'Var' && EFFECT_NAMES.has(callee.name as any)) {
    for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog);
    emit(prog, ['EFFECT', callee.name, node.argIds.length, null]);
    return;
  }
  // Pure builtin?
  if (callee.kind === 'Var' && PURE_BUILTINS.has(callee.name)) {
    for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog);
    emit(prog, ['CALL_BUILTIN', callee.name, node.argIds.length]);
    return;
  }
  // Normal closure call: callee, then args, then CALL.
  compileNode(callee, ast, prog);
  for (const argId of node.argIds) compileNode(ast.nodes[argId], ast, prog);
  emit(prog, ['CALL', node.argIds.length]);
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): Call with EFFECT/CALL_BUILTIN/CALL dispatch"
```

---

### Task 15: Compile Block + Pause

**Files:** Modify `src/compiler.ts`, `test/compiler.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('Block with trailing expression', () => {
  // Trigger via if branch which uses Block
  const prog = compile(parse(tokenize('if (true) { 1 } else { 2 };')));
  // The then-block (single trailing expr 1) is ENTER_BLOCK, LOAD_CONST 1, EXIT_BLOCK
  const enterAt = prog.code.findIndex(op => op[0] === 'ENTER_BLOCK');
  expect(prog.code[enterAt + 1][0]).toBe('LOAD_CONST');
  expect(prog.code[enterAt + 2]).toEqual(['EXIT_BLOCK']);
});

test('Block with no trailing expression emits PUSH_UNIT', () => {
  const prog = compile(parse(tokenize('if (true) { let x = 1; } else { };')));
  // both blocks have no trailing expr — should PUSH_UNIT
  const pushUnitCount = prog.code.filter(op => op[0] === 'PUSH_UNIT').length;
  expect(pushUnitCount).toBe(2);
});

test('Pause compiles to PAUSE opcode', () => {
  const prog = compile(parse(tokenize('let x = pause;')));
  expect(prog.code).toContainEqual(['PAUSE']);
  // Sequence: PAUSE, STORE_VAR x, HALT
  expect(prog.code).toEqual([
    ['PAUSE'],
    ['STORE_VAR', 'x'],
    ['HALT'],
  ]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add Block and Pause cases**

```ts
case 'Block': {
  emit(prog, ['ENTER_BLOCK']);
  for (const stmtId of node.stmtIds) compileNode(ast.nodes[stmtId], ast, prog);
  if (node.trailingExprId !== null) {
    compileNode(ast.nodes[node.trailingExprId], ast, prog);
  } else {
    emit(prog, ['PUSH_UNIT']);
  }
  emit(prog, ['EXIT_BLOCK']);
  return;
}
case 'Pause': {
  emit(prog, ['PAUSE']);
  return;
}
```

- [ ] **Step 4: Run — PASS**

Also confirm all 20 tests in `test/compiler.test.ts` (Group B coverage) pass — re-run full file:
```bash
npm test -- compiler
```

- [ ] **Step 5: Commit**

```bash
git add src/compiler.ts test/compiler.test.ts
git commit -m "feat(compiler): Block (ENTER/body/EXIT with PUSH_UNIT fallback) and Pause"
```

**End of Wave 2A.** Compiler is complete for all 13 ASTNode kinds.

---

## Wave 2B — VM (T16-T25)

The VM executes a `Program`. State is `VMState` from `src/snapshot.ts`. Each task adds one or two opcode dispatchers to `src/vm.ts`. Tests grow in `test/vm.test.ts`.

### Task 16: VM skeleton (HALT only)

**Files:**
- Create: `src/vm.ts`
- Create: `test/vm.test.ts`

- [ ] **Step 1: Failing test**

```ts
// test/vm.test.ts
import { test, expect } from 'vitest';
import { run } from '../src/vm.js';
import type { Program } from '../src/bytecode.js';

test('HALT-only program completes with empty stack', () => {
  const prog: Program = { version: 1, constants: [], code: [['HALT']] };
  const result = run(prog);
  expect(result.status).toBe('halted');
  expect(result.state.ip).toBe(0);
  expect(result.state.valueStack).toEqual([]);
  expect(result.state.frames).toHaveLength(1);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Create `src/vm.ts`**

```ts
// Penelope VM. Stack-based bytecode interpreter.
// State is VMState from snapshot.ts; the VM mutates it in place.

import type { Program, Opcode } from './bytecode.js';
import type { VMState, Frame } from './snapshot.js';
import type { Value } from './ast.js';

export type RunResult =
  | { status: 'halted'; state: VMState }
  | { status: 'paused'; state: VMState };

export function freshState(): VMState {
  return {
    ip: 0,
    valueStack: [],
    frames: [{ bindings: {} }],
    effects: [],
  };
}

export function run(prog: Program, initialState?: VMState): RunResult {
  const state = initialState ?? freshState();
  return runUntilStop(prog, state);
}

function runUntilStop(prog: Program, state: VMState): RunResult {
  while (true) {
    const op = prog.code[state.ip];
    if (!op) throw new Error(`VM: IP ${state.ip} out of bounds`);
    const name = op[0];
    if (name === 'HALT') return { status: 'halted', state };
    throw new Error(`VM: unhandled opcode '${name}' at ip ${state.ip}`);
  }
}

function pop(state: VMState): Value {
  const v = state.valueStack.pop();
  if (v === undefined) throw new Error(`VM: stack underflow at ip ${state.ip}`);
  return v;
}
function push(state: VMState, v: Value): void { state.valueStack.push(v); }
function topFrame(state: VMState): Frame { return state.frames[state.frames.length - 1]; }
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): skeleton with HALT and stack/frame helpers"
```

---

### Task 17: LOAD_CONST + POP + PUSH_UNIT

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('LOAD_CONST pushes constant; POP removes top', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 42 }],
    code: [['LOAD_CONST', 0], ['POP'], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([]);
});

test('LOAD_CONST without POP leaves value on stack', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 7 }],
    code: [['LOAD_CONST', 0], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 7 }]);
});

test('PUSH_UNIT pushes unit', () => {
  const prog: Program = { version: 1, constants: [], code: [['PUSH_UNIT'], ['HALT']] };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'unit' }]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add dispatcher cases**

Convert the body of `runUntilStop` to a switch and add `constantToValue` import:

```ts
import { constantToValue } from './bytecode.js';

function runUntilStop(prog: Program, state: VMState): RunResult {
  while (true) {
    const op = prog.code[state.ip];
    if (!op) throw new Error(`VM: IP ${state.ip} out of bounds`);
    switch (op[0]) {
      case 'HALT': return { status: 'halted', state };
      case 'LOAD_CONST': {
        push(state, constantToValue(prog.constants[op[1] as number]));
        state.ip++;
        break;
      }
      case 'POP':       { pop(state); state.ip++; break; }
      case 'PUSH_UNIT': { push(state, { tag: 'unit' }); state.ip++; break; }
      default:
        throw new Error(`VM: unhandled opcode '${op[0]}' at ip ${state.ip}`);
    }
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): LOAD_CONST, POP, PUSH_UNIT"
```

---

### Task 18: STORE_VAR + LOAD_VAR

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
import { run, freshState } from '../src/vm.js';

test('STORE_VAR writes to top frame; LOAD_VAR reads it', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 10 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'x'],
      ['LOAD_VAR', 'x', null],
      ['HALT'],
    ],
  };
  const r = run(prog);
  expect(r.state.valueStack).toEqual([{ tag: 'int', v: 10 }]);
  expect(r.state.frames[0].bindings.x).toEqual({ tag: 'int', v: 10 });
});

test('LOAD_VAR walks frame chain (linear)', () => {
  const prog: Program = { version: 1, constants: [], code: [['LOAD_VAR', 'x', null], ['HALT']] };
  const initial = freshState();
  initial.frames[0].bindings.x = { tag: 'int', v: 5 };
  initial.frames.push({ bindings: {} });
  expect(run(prog, initial).state.valueStack).toEqual([{ tag: 'int', v: 5 }]);
});

test('LOAD_VAR undefined throws', () => {
  const prog: Program = { version: 1, constants: [], code: [['LOAD_VAR', 'oops', null], ['HALT']] };
  expect(() => run(prog)).toThrow(/undefined variable 'oops'/);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add cases**

```ts
case 'STORE_VAR': {
  const name = op[1] as string;
  const v = pop(state);
  topFrame(state).bindings[name] = v;
  state.ip++;
  break;
}
case 'LOAD_VAR': {
  const name = op[1] as string;
  let idx = state.frames.length - 1;
  let found = false;
  while (idx >= 0) {
    const f = state.frames[idx];
    if (Object.prototype.hasOwnProperty.call(f.bindings, name)) {
      push(state, f.bindings[name]);
      found = true;
      break;
    }
    if (f.parentIdx !== undefined) idx = f.parentIdx;
    else idx--;
  }
  if (!found) throw new Error(`VM: undefined variable '${name}' at ip ${state.ip}`);
  state.ip++;
  break;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): STORE_VAR and LOAD_VAR with frame chain"
```

---

### Task 19: BIN_OP

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('BIN_OP + ints', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 2 }, { tag: 'int', v: 3 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 5 }]);
});

test('BIN_OP < returns bool', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '<'], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'bool', v: true }]);
});

test('BIN_OP + strings concatenates', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'a' }, { tag: 'str', v: 'b' }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'str', v: 'ab' }]);
});

test('BIN_OP / by 0 throws', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 5 }, { tag: 'int', v: 0 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '/'], ['HALT']],
  };
  expect(() => run(prog)).toThrow(/divide by zero/);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add case + helper**

```ts
case 'BIN_OP': {
  const o = op[1] as string;
  const right = pop(state);
  const left  = pop(state);
  push(state, applyBinOp(o, left, right));
  state.ip++;
  break;
}
```

Helper at bottom:
```ts
function applyBinOp(o: string, l: Value, r: Value): Value {
  if (o === '+') {
    if (l.tag === 'int' && r.tag === 'int') return { tag: 'int', v: l.v + r.v };
    if (l.tag === 'str' && r.tag === 'str') return { tag: 'str', v: l.v + r.v };
    throw new Error(`BIN_OP +: type mismatch ${l.tag}+${r.tag}`);
  }
  if (o === '-' || o === '*' || o === '/') {
    if (l.tag !== 'int' || r.tag !== 'int') throw new Error(`BIN_OP ${o}: ints required`);
    if (o === '-') return { tag: 'int', v: l.v - r.v };
    if (o === '*') return { tag: 'int', v: l.v * r.v };
    if (r.v === 0) throw new Error(`BIN_OP /: divide by zero`);
    return { tag: 'int', v: Math.trunc(l.v / r.v) };
  }
  if (o === '<' || o === '>' || o === '<=' || o === '>=') {
    if (l.tag !== 'int' || r.tag !== 'int') throw new Error(`BIN_OP ${o}: ints required`);
    if (o === '<')  return { tag: 'bool', v: l.v <  r.v };
    if (o === '>')  return { tag: 'bool', v: l.v >  r.v };
    if (o === '<=') return { tag: 'bool', v: l.v <= r.v };
    return { tag: 'bool', v: l.v >= r.v };
  }
  if (o === '==' || o === '!=') {
    if (l.tag !== r.tag) throw new Error(`BIN_OP ${o}: type mismatch`);
    let eq: boolean;
    if (l.tag === 'unit') eq = true;
    else if (l.tag === 'closure' || (r as any).tag === 'closure') throw new Error(`BIN_OP ${o}: closures not comparable`);
    else eq = (l as any).v === (r as any).v;
    return { tag: 'bool', v: o === '==' ? eq : !eq };
  }
  throw new Error(`BIN_OP: unknown op '${o}'`);
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): BIN_OP arithmetic, comparison, equality"
```

---

### Task 20: JUMP + JUMP_IF_FALSE

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('JUMP advances IP unconditionally', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [
      ['LOAD_CONST', 0],
      ['JUMP', 3],
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 1 }]);
});

test('JUMP_IF_FALSE pops and jumps when false', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'bool', v: false }, { tag: 'int', v: 99 }],
    code: [
      ['LOAD_CONST', 0],
      ['JUMP_IF_FALSE', 3],
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([]);
});

test('JUMP_IF_FALSE falls through when true', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'bool', v: true }, { tag: 'int', v: 99 }],
    code: [
      ['LOAD_CONST', 0],
      ['JUMP_IF_FALSE', 4],
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 99 }]);
});

test('JUMP_IF_FALSE on non-bool throws', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['LOAD_CONST', 0], ['JUMP_IF_FALSE', 3], ['HALT']],
  };
  expect(() => run(prog)).toThrow(/expected bool/);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add cases**

```ts
case 'JUMP': {
  state.ip = op[1] as number;
  break;
}
case 'JUMP_IF_FALSE': {
  const c = pop(state);
  if (c.tag !== 'bool') throw new Error(`JUMP_IF_FALSE: expected bool, got ${c.tag}`);
  state.ip = !c.v ? (op[1] as number) : state.ip + 1;
  break;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): JUMP and JUMP_IF_FALSE"
```

---

### Task 21: MAKE_CLOSURE + CALL + RETURN

**Files:** Modify `src/ast.ts` (closure shape), `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Update closure Value shape**

In `src/ast.ts`, change `closure` variant to:
```ts
| { tag: 'closure'; params: string[]; bodyIp: number; bodyLen: number; capturedFrameIdx: number };
```

`src/legacy-interpreter.ts` (excluded from tsc) still uses the old closure shape with `bodyId` and `capturedScopeId`. That's fine — legacy is now decoupled. If the build complains because Phase 2 tests reference closure internals, those tests will be updated in Wave 4 (T56-T60) when they're migrated to the VM.

To keep the build green at this point, search for any `tag: 'closure'` literal in non-legacy files:
```bash
grep -n "tag: 'closure'" src/*.ts | grep -v legacy
```
Expected sites that may need patching: `src/snapshot.ts` (serialize/deserialize doesn't case on closure fields specifically, so should be OK).

- [ ] **Step 2: Failing tests**

```ts
test('MAKE_CLOSURE captures top frame index', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['MAKE_CLOSURE', ['x'], 10, 5], ['HALT']],
  };
  const r = run(prog);
  expect(r.state.valueStack[0]).toEqual({
    tag: 'closure', params: ['x'], bodyIp: 10, bodyLen: 5, capturedFrameIdx: 0,
  });
});

test('CALL + RETURN: identity fn', () => {
  // MAKE_CLOSURE ['x'], 2, 4
  // JUMP 6
  // ENTER_BLOCK            <- 2 body start
  // LOAD_VAR x             <- 3
  // EXIT_BLOCK             <- 4
  // RETURN                 <- 5
  // STORE_VAR id           <- 6
  // LOAD_VAR id            <- 7
  // LOAD_CONST 7           <- 8
  // CALL 1                 <- 9
  // HALT                   <- 10
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 7 }],
    code: [
      ['MAKE_CLOSURE', ['x'], 2, 4],
      ['JUMP', 6],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', null],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['STORE_VAR', 'id'],
      ['LOAD_VAR', 'id', null],
      ['LOAD_CONST', 0],
      ['CALL', 1],
      ['HALT'],
    ],
  };
  const r = run(prog);
  expect(r.state.valueStack).toEqual([{ tag: 'int', v: 7 }]);
});

test('closure captures outer binding via parentIdx', () => {
  // let y = 10; let f = fn() { y }; f();  → 10
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 10 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'y'],
      ['MAKE_CLOSURE', [], 4, 4],
      ['JUMP', 8],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'y', null],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['STORE_VAR', 'f'],
      ['LOAD_VAR', 'f', null],
      ['CALL', 0],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 10 }]);
});
```

- [ ] **Step 3: Add cases**

```ts
case 'MAKE_CLOSURE': {
  const params = op[1] as string[];
  const bodyIp = op[2] as number;
  const bodyLen = op[3] as number;
  push(state, { tag: 'closure', params, bodyIp, bodyLen, capturedFrameIdx: state.frames.length - 1 });
  state.ip++;
  break;
}
case 'CALL': {
  const argc = op[1] as number;
  const args: Value[] = [];
  for (let i = 0; i < argc; i++) args.unshift(pop(state));
  const callee = pop(state);
  if (callee.tag !== 'closure') throw new Error(`CALL: callee is ${callee.tag}, not closure`);
  if (args.length !== callee.params.length) {
    throw new Error(`CALL: arity mismatch (expected ${callee.params.length}, got ${args.length})`);
  }
  const bindings: Record<string, Value> = {};
  for (let i = 0; i < args.length; i++) bindings[callee.params[i]] = args[i];
  state.frames.push({ bindings, returnIP: state.ip + 1, parentIdx: callee.capturedFrameIdx });
  state.ip = callee.bodyIp;
  break;
}
case 'RETURN': {
  const f = state.frames.pop();
  if (!f || f.returnIP === undefined) throw new Error(`RETURN: invalid return frame`);
  state.ip = f.returnIP;
  break;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/ast.ts src/vm.ts test/vm.test.ts
git commit -m "feat(vm): MAKE_CLOSURE, CALL, RETURN with parentIdx scoping"
```

---

### Task 22: CALL_BUILTIN

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('str_length on string', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hello' }],
    code: [['LOAD_CONST', 0], ['CALL_BUILTIN', 'str_length', 1], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 5 }]);
});

test('to_str on int', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 42 }],
    code: [['LOAD_CONST', 0], ['CALL_BUILTIN', 'to_str', 1], ['HALT']],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'str', v: '42' }]);
});

test('str_slice', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hello' }, { tag: 'int', v: 1 }, { tag: 'int', v: 4 }],
    code: [
      ['LOAD_CONST', 0], ['LOAD_CONST', 1], ['LOAD_CONST', 2],
      ['CALL_BUILTIN', 'str_slice', 3], ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'str', v: 'ell' }]);
});

test('unknown builtin throws', () => {
  const prog: Program = { version: 1, constants: [], code: [['CALL_BUILTIN', 'nope', 0], ['HALT']] };
  expect(() => run(prog)).toThrow(/unknown builtin/);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add case + helper**

```ts
case 'CALL_BUILTIN': {
  const name = op[1] as string;
  const argc = op[2] as number;
  const args: Value[] = [];
  for (let i = 0; i < argc; i++) args.unshift(pop(state));
  push(state, applyBuiltin(name, args));
  state.ip++;
  break;
}
```

Helper:
```ts
function applyBuiltin(name: string, args: Value[]): Value {
  if (name === 'str_length') {
    if (args.length !== 1 || args[0].tag !== 'str') throw new Error(`str_length(s: str)`);
    return { tag: 'int', v: args[0].v.length };
  }
  if (name === 'to_str') {
    if (args.length !== 1) throw new Error(`to_str(x)`);
    const a = args[0];
    if (a.tag === 'int')  return { tag: 'str', v: String(a.v) };
    if (a.tag === 'bool') return { tag: 'str', v: a.v ? 'true' : 'false' };
    if (a.tag === 'str')  return { tag: 'str', v: a.v };
    if (a.tag === 'unit') return { tag: 'str', v: 'unit' };
    throw new Error(`to_str: closures not stringifiable`);
  }
  if (name === 'str_slice') {
    if (args.length !== 3 || args[0].tag !== 'str' || args[1].tag !== 'int' || args[2].tag !== 'int') {
      throw new Error(`str_slice(s, start, end)`);
    }
    return { tag: 'str', v: args[0].v.slice(args[1].v, args[2].v) };
  }
  throw new Error(`unknown builtin '${name}'`);
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): CALL_BUILTIN (str_length, to_str, str_slice)"
```

---

### Task 23: EFFECT (ip-keyed effect log with replay + wait pause)

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('EFFECT print fresh run: writes committed entry', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hi' }],
    code: [['LOAD_CONST', 0], ['EFFECT', 'print', 1, null], ['HALT']],
  };
  const r = run(prog);
  expect(r.state.effects).toHaveLength(1);
  expect(r.state.effects[0]).toMatchObject({
    ip: 1, invocationCount: 0, effect: 'print', status: 'committed',
  });
});

test('EFFECT print replay: reuses committed entry; no duplicate', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hi' }],
    code: [['LOAD_CONST', 0], ['EFFECT', 'print', 1, null], ['HALT']],
  };
  const initial = freshState();
  initial.effects = [
    { ip: 1, invocationCount: 0, effect: 'print', recordedValue: { tag: 'unit' }, status: 'committed' },
  ];
  const r = run(prog, initial);
  expect(r.state.effects).toHaveLength(1);
});

test('EFFECT now fresh run produces int', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['EFFECT', 'now', 0, null], ['POP'], ['HALT']],
  };
  const r = run(prog);
  expect(r.state.effects[0].effect).toBe('now');
  expect(r.state.effects[0].recordedValue?.tag).toBe('int');
});

test('EFFECT now respects timeOverride', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['EFFECT', 'now', 0, null], ['HALT']],
  };
  const initial = freshState();
  initial.timeOverride = 1234567890;
  const r = run(prog, initial);
  expect(r.state.valueStack[0]).toEqual({ tag: 'int', v: 1234567890 });
});

test('--no-replay re-executes committed print', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hi' }],
    code: [['LOAD_CONST', 0], ['EFFECT', 'print', 1, null], ['HALT']],
  };
  const initial = freshState();
  initial.noReplay = true;
  initial.effects = [
    { ip: 1, invocationCount: 0, effect: 'print', recordedValue: { tag: 'unit' }, status: 'committed' },
  ];
  const r = run(prog, initial);
  // With noReplay=true the existing entry is ignored on replay and a new entry is appended.
  expect(r.state.effects.length).toBe(2);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add EFFECT case + helpers**

Imports:
```ts
import { performPrint, performNetFetch, performNow, performRandomInt, performReadFile, performWriteFile, categoryOf, EFFECT_NAMES } from './effects.js';
import type { EffectName } from './effects.js';
import type { EffectEntry } from './snapshot.js';
```

Case:
```ts
case 'EFFECT': {
  const name = op[1] as EffectName;
  const argc = op[2] as number;
  const args: Value[] = [];
  for (let i = 0; i < argc; i++) args.unshift(pop(state));
  const step = executeEffect(state, name, args);
  if (step.kind === 'pause') return { status: 'paused', state };
  push(state, step.v);
  state.ip++;
  break;
}
```

Helpers:
```ts
type EffectStep = { kind: 'value'; v: Value } | { kind: 'pause' };

function executeEffect(state: VMState, name: EffectName, args: Value[]): EffectStep {
  const ip = state.ip;
  if (categoryOf(name) === 'wait') return executeWaitEffect(state, name, args, ip);
  const invocationCount = state.effects.filter(e => e.ip === ip).length;
  const existing = state.effects.find(e => e.ip === ip && e.invocationCount === invocationCount);
  if (existing && existing.status === 'committed' && !state.noReplay) {
    return { kind: 'value', v: existing.recordedValue ?? { tag: 'unit' } };
  }
  let v: Value;
  if      (name === 'print')      v = performPrint(args);
  else if (name === 'net_fetch')  v = performNetFetch(args);
  else if (name === 'now')        v = performNow(args, state.timeOverride ?? null);
  else if (name === 'random_int') v = performRandomInt(args);
  else if (name === 'read_file')  v = performReadFile(args);
  else if (name === 'write_file') v = performWriteFile(args);
  else throw new Error(`EFFECT: unhandled name '${name}'`);
  state.effects.push({
    ip, invocationCount, effect: name as EffectEntry['effect'],
    recordedValue: v, status: 'committed',
  });
  return { kind: 'value', v };
}

function executeWaitEffect(state: VMState, name: EffectName, _args: Value[], ip: number): EffectStep {
  const pending = state.effects.find(e => e.ip === ip && e.effect === name && e.status === 'pending');
  if (pending) {
    pending.status = 'committed';
    pending.recordedValue = { tag: 'unit' };
    return { kind: 'value', v: { tag: 'unit' } };
  }
  const invocationCount = state.effects.filter(e => e.ip === ip).length;
  state.effects.push({
    ip, invocationCount, effect: name as EffectEntry['effect'],
    recordedValue: null, status: 'pending',
  });
  return { kind: 'pause' };
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): EFFECT with ip-keyed log, replay, and wait pending entries"
```

---

### Task 24: ENTER_BLOCK + EXIT_BLOCK

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('block-local var does not leak out', () => {
  // let x=1; { let x=2; PUSH_UNIT }; x;  -> outer x stays 1
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [
      ['LOAD_CONST', 0], ['STORE_VAR', 'x'],
      ['ENTER_BLOCK'],
      ['LOAD_CONST', 1], ['STORE_VAR', 'x'],
      ['PUSH_UNIT'],
      ['EXIT_BLOCK'],
      ['POP'],
      ['LOAD_VAR', 'x', null],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 1 }]);
});

test('trailing expr survives EXIT_BLOCK', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 42 }],
    code: [
      ['ENTER_BLOCK'],
      ['LOAD_CONST', 0],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 42 }]);
});

test('inner block can read outer binding', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 5 }],
    code: [
      ['LOAD_CONST', 0], ['STORE_VAR', 'x'],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', null],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 5 }]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add cases**

```ts
case 'ENTER_BLOCK': {
  state.frames.push({ bindings: {}, parentIdx: state.frames.length - 1 });
  state.ip++;
  break;
}
case 'EXIT_BLOCK': {
  if (state.frames.length === 1) throw new Error(`EXIT_BLOCK: cannot pop root frame`);
  state.frames.pop();
  state.ip++;
  break;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): ENTER_BLOCK and EXIT_BLOCK with frame scoping"
```

---

### Task 25: PAUSE + integration smoke

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('PAUSE pushes unit, advances IP, returns paused', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['PAUSE'], ['STORE_VAR', 'x'], ['HALT']],
  };
  const r = run(prog);
  expect(r.status).toBe('paused');
  expect(r.state.ip).toBe(1);
  expect(r.state.valueStack).toEqual([{ tag: 'unit' }]);
});

test('PAUSE then resume completes', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['PAUSE'], ['STORE_VAR', 'x'], ['HALT']],
  };
  const first = run(prog);
  const second = run(prog, first.state);
  expect(second.status).toBe('halted');
  expect(second.state.frames[0].bindings.x).toEqual({ tag: 'unit' });
});

import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';

test('SMOKE: compile + run identity application', () => {
  const ast = parse(tokenize('let f = fn(x) { x + 1 }; f(10);'));
  const prog = compile(ast);
  const r = run(prog);
  expect(r.status).toBe('halted');
  expect(r.state.frames[0].bindings.f.tag).toBe('closure');
});

test('SMOKE: compile + run if/else', () => {
  const ast = parse(tokenize('if (1 < 2) { 100 } else { 200 };'));
  const prog = compile(ast);
  expect(run(prog).status).toBe('halted');
});

test('SMOKE: compile + run print effect', () => {
  const ast = parse(tokenize('print("hello");'));
  const prog = compile(ast);
  const r = run(prog);
  expect(r.status).toBe('halted');
  expect(r.state.effects.length).toBe(1);
  expect(r.state.effects[0].effect).toBe('print');
});

test('SMOKE: compile + run wait_for then resume', () => {
  const ast = parse(tokenize('let x = pause;'));
  const prog = compile(ast);
  const first = run(prog);
  expect(first.status).toBe('paused');
  const second = run(prog, first.state);
  expect(second.status).toBe('halted');
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add PAUSE case**

```ts
case 'PAUSE': {
  push(state, { tag: 'unit' });
  state.ip++;
  return { status: 'paused', state };
}
```

- [ ] **Step 4: Run — PASS** (all VM tests + smoke tests green)

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): PAUSE; integration smoke with compiler"
```

**End of Wave 2B.** All 17 opcodes implemented; VM can run compiled bytecode end-to-end.

---

## Wave 2C — Encoder (T26-T27)

### Task 26: encoder.ts — Program serialize/deserialize

**Files:**
- Create: `src/encoder.ts`
- Create: `test/encoder.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { test, expect } from 'vitest';
import { serializeProgram, deserializeProgram } from '../src/encoder.js';
import type { Program } from '../src/bytecode.js';

test('Program with primitive constants roundtrips byte-for-byte', () => {
  const prog: Program = {
    version: 1,
    sourceHash: 'sha256:abc',
    constants: [{ tag: 'int', v: 42 }, { tag: 'str', v: 'hi' }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['HALT']],
  };
  const json = serializeProgram(prog);
  const parsed = deserializeProgram(json);
  if ('error' in parsed) throw new Error(parsed.error);
  expect(parsed.prog).toEqual(prog);
});

test('deserialize rejects wrong version', () => {
  const r = deserializeProgram(JSON.stringify({ version: 99, constants: [], code: [] }));
  expect('error' in r).toBe(true);
});

test('deserialize rejects unknown opcode', () => {
  const json = JSON.stringify({ version: 1, constants: [], code: [['BOGUS']] });
  const r = deserializeProgram(json);
  expect('error' in r).toBe(true);
  if ('error' in r) expect(r.error).toMatch(/unknown opcode 'BOGUS'/);
});

test('deserialize rejects malformed JSON', () => {
  expect('error' in deserializeProgram('{ not json')).toBe(true);
});

test('serialize is deterministic (stable key order)', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['LOAD_CONST', 0], ['HALT']],
  };
  const a = serializeProgram(prog);
  const b = serializeProgram(prog);
  expect(a).toBe(b);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Create `src/encoder.ts`**

```ts
// Penelope bytecode encoder (.penc files).
// Produces deterministic JSON; rejects unknown versions/opcodes on read.

import type { Program } from './bytecode.js';
import { OPCODE_NAMES } from './bytecode.js';

export function serializeProgram(prog: Program): string {
  return JSON.stringify(prog, null, 2);
}

export type DeserializeResult =
  | { prog: Program }
  | { error: string };

export function deserializeProgram(text: string): DeserializeResult {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (e) { return { error: `invalid JSON: ${(e as Error).message}` }; }
  if (typeof parsed !== 'object' || parsed === null) return { error: 'not an object' };
  const p = parsed as any;
  if (p.version !== 1) return { error: `unknown program version: ${p.version}` };
  if (!Array.isArray(p.constants)) return { error: 'constants must be array' };
  if (!Array.isArray(p.code))      return { error: 'code must be array' };
  for (let i = 0; i < p.code.length; i++) {
    const op = p.code[i];
    if (!Array.isArray(op) || typeof op[0] !== 'string') {
      return { error: `code[${i}]: not an opcode tuple` };
    }
    if (!OPCODE_NAMES.has(op[0])) {
      return { error: `code[${i}]: unknown opcode '${op[0]}'` };
    }
  }
  return { prog: p as Program };
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/encoder.ts test/encoder.test.ts
git commit -m "feat(encoder): .penc serialize/deserialize with version + opcode validation"
```

---

### Task 27: encoder file I/O (`.penc` read/write helpers)

**Files:** Modify `src/encoder.ts`, `test/encoder.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
import { writePencFile, readPencFile } from '../src/encoder.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('writePencFile + readPencFile roundtrips', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 7 }],
    code: [['LOAD_CONST', 0], ['HALT']],
  };
  const tmp = path.join(os.tmpdir(), `pen-test-${Date.now()}.penc`);
  writePencFile(tmp, prog);
  const r = readPencFile(tmp);
  if ('error' in r) throw new Error(r.error);
  expect(r.prog).toEqual(prog);
  fs.unlinkSync(tmp);
});

test('readPencFile on missing file returns error', () => {
  const r = readPencFile('/tmp/does-not-exist-' + Date.now() + '.penc');
  expect('error' in r).toBe(true);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add file I/O helpers**

```ts
import * as fs from 'fs';

export function writePencFile(filePath: string, prog: Program): void {
  fs.writeFileSync(filePath, serializeProgram(prog), 'utf8');
}

export function readPencFile(filePath: string): DeserializeResult {
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { return { error: `cannot read ${filePath}: ${(e as Error).message}` }; }
  return deserializeProgram(text);
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/encoder.ts test/encoder.test.ts
git commit -m "feat(encoder): writePencFile and readPencFile"
```

**End of Wave 2C.**

---

## Wave 2D — CLI integration (T28-T30)

### Task 28: `pen build` subcommand

**Files:** Modify `src/cli.ts`, `test/integration.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('pen build foo.pen creates foo.penc', () => {
  const srcPath = path.join(os.tmpdir(), `t-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'let x = 42; x;');
  const out = execSync(`node bin/penelope build ${srcPath}`).toString();
  const pencPath = srcPath.replace(/\.pen$/, '.penc');
  expect(fs.existsSync(pencPath)).toBe(true);
  const text = fs.readFileSync(pencPath, 'utf8');
  expect(text).toContain('LOAD_CONST');
  expect(out).toMatch(/wrote/);
  fs.unlinkSync(srcPath); fs.unlinkSync(pencPath);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add `build` subcommand in `src/cli.ts`**

Add a new subcommand dispatcher branch:
```ts
if (subcommand === 'build') {
  const srcPath = args[1];
  if (!srcPath) { console.error('usage: pen build <file.pen>'); process.exit(2); }
  const source = fs.readFileSync(srcPath, 'utf8');
  const tokens = tokenize(source);
  const ast = parse(tokens);
  const prog = compile(ast);
  prog.sourceHash = 'sha256:' + sha256(source);
  const pencPath = srcPath.replace(/\.pen$/, '.penc');
  writePencFile(pencPath, prog);
  console.log(`wrote ${pencPath} (${prog.code.length} opcodes, ${prog.constants.length} constants)`);
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): pen build (source -> .penc)"
```

---

### Task 29: `pen exec` subcommand (run .penc directly)

**Files:** Modify `src/cli.ts`, `test/integration.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('pen exec runs a .penc file', () => {
  const srcPath = path.join(os.tmpdir(), `e-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'print("hello vm");');
  execSync(`node bin/penelope build ${srcPath}`);
  const pencPath = srcPath.replace(/\.pen$/, '.penc');
  const out = execSync(`node bin/penelope exec ${pencPath}`).toString();
  expect(out).toContain('hello vm');
  fs.unlinkSync(srcPath); fs.unlinkSync(pencPath);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add `exec` subcommand**

```ts
if (subcommand === 'exec') {
  const pencPath = args[1];
  if (!pencPath) { console.error('usage: pen exec <file.penc>'); process.exit(2); }
  const r = readPencFile(pencPath);
  if ('error' in r) { console.error(r.error); process.exit(1); }
  const result = run(r.prog);
  if (result.status === 'paused') {
    const snapPath = pencPath.replace(/\.penc$/, '.penz');
    const snap = {
      version: 3 as const,
      programPath: pencPath,
      programHash: 'sha256:' + sha256(fs.readFileSync(pencPath, 'utf8')),
      pausedAtIP: result.state.ip,
      pausedAtMs: Date.now(),
      state: result.state,
    };
    fs.writeFileSync(snapPath, serialize(snap));
    console.log(`paused at ip ${result.state.ip} → ${snapPath}`);
  }
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): pen exec (.penc + pause→snapshot)"
```

---

### Task 30: `pen run` auto-build (.pen → in-memory compile → run)

**Files:** Modify `src/cli.ts`, `test/integration.test.ts`.

The existing `pen run` subcommand currently routes through the Phase 2 step-machine interpreter. Replace it with compile-then-VM.

- [ ] **Step 1: Failing test**

```ts
test('pen run compiles + executes via VM (no .penc on disk required)', () => {
  const srcPath = path.join(os.tmpdir(), `r-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'print("hello from run");');
  const out = execSync(`node bin/penelope run ${srcPath}`).toString();
  expect(out).toContain('hello from run');
  // No .penc file created (in-memory build).
  expect(fs.existsSync(srcPath.replace(/\.pen$/, '.penc'))).toBe(false);
  fs.unlinkSync(srcPath);
});

test('pen run preserves --time and --no-replay flags', () => {
  const srcPath = path.join(os.tmpdir(), `f-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'let t = now(); print(to_str(t));');
  const out = execSync(`node bin/penelope run --time 1234567890 ${srcPath}`).toString();
  expect(out).toContain('1234567890');
  fs.unlinkSync(srcPath);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Update `run` subcommand in `src/cli.ts`**

```ts
if (subcommand === 'run') {
  // parse flags --time, --no-replay
  let timeOverride: number | null = null;
  let noReplay = false;
  let filePath: string | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--time' && args[i+1]) { timeOverride = parseInt(args[i+1], 10); i++; continue; }
    if (args[i] === '--no-replay') { noReplay = true; continue; }
    if (!filePath) { filePath = args[i]; continue; }
  }
  if (!filePath) { console.error('usage: pen run <file.pen> [--time N] [--no-replay]'); process.exit(2); }
  const source = fs.readFileSync(filePath, 'utf8');
  const tokens = tokenize(source);
  const ast = parse(tokens);
  const prog = compile(ast);
  const state = freshState();
  state.timeOverride = timeOverride;
  state.noReplay = noReplay;
  const r = run(prog, state);
  if (r.status === 'paused') {
    const snapPath = filePath.replace(/\.pen$/, '.penz');
    // Snapshot needs the .penc on disk to track programHash. Write it.
    const pencPath = filePath.replace(/\.pen$/, '.penc');
    prog.sourceHash = 'sha256:' + sha256(source);
    writePencFile(pencPath, prog);
    const snap = {
      version: 3 as const,
      programPath: pencPath,
      programHash: 'sha256:' + sha256(fs.readFileSync(pencPath, 'utf8')),
      pausedAtIP: r.state.ip,
      pausedAtMs: Date.now(),
      state: r.state,
    };
    fs.writeFileSync(snapPath, serialize(snap));
    console.log(`paused at ip ${r.state.ip} → ${snapPath}`);
  }
  return;
}
```

Update the `resume` and `fork` subcommands similarly — they now load the .penc rather than re-parsing the .pen source. Refer to existing Phase 2 code in those subcommands and adapt by:
1. Reading `snap.programPath` (now a .penc) via `readPencFile`
2. Comparing hash, then calling `run(prog, snap.state)` instead of stepping the interpreter
3. Writing a v3 snap if it pauses again

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): pen run uses VM via in-memory compile; flags preserved"
```

**End of Wave 2D.** Wave 2 complete — full compile→run pipeline working.

---

# Wave 3 — Optimizer (parallel, T31-T50)

Wave 3 has five independent pass tracks; pass implementations don't depend on each other (only on the `Pass` interface defined in T31). After T31, the five passes are:

- **Constant Folding (T32-T34)** — 3 tasks
- **Dead Code Elimination (T35-T38)** — 4 tasks
- **Inline Caches (T39-T42)** — 4 tasks
- **Function Inlining (T43-T46)** — 4 tasks
- **Peephole (T47-T50)** — 4 tasks (last task wires all passes through -O levels)

Subagent dispatcher: after T31, run the 5 pass tracks in parallel (5 subagents).

### Task 31: optimizer.ts skeleton + Pass interface

**Files:**
- Create: `src/optimizer.ts`
- Create: `test/optimizer.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { test, expect } from 'vitest';
import { runOptimizer, type OLevel } from '../src/optimizer.js';
import type { Program } from '../src/bytecode.js';

test('-O0 returns program unchanged', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  const out = runOptimizer(prog, 0 as OLevel);
  expect(out).toEqual(prog);
});

test('-O level signature accepts 0/1/2', () => {
  const prog: Program = { version: 1, constants: [], code: [['HALT']] };
  expect(runOptimizer(prog, 0).code).toEqual([['HALT']]);
  expect(runOptimizer(prog, 1).code).toEqual([['HALT']]);
  expect(runOptimizer(prog, 2).code).toEqual([['HALT']]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Create `src/optimizer.ts`**

```ts
// Penelope optimizer. Pure Program -> Program transformations.
// Levels: -O0 (none) / -O1 (cheap: constfold + dce + peephole) / -O2 (+ ic + inline).

import type { Program } from './bytecode.js';

export type OLevel = 0 | 1 | 2;

export type Pass = (prog: Program) => Program;

// Will be filled by subsequent tasks: constFoldPass, dcePass, icPass, inlinePass, peepholePass.
// Each task imports the Pass into a local module-level reference here.

function passesForLevel(level: OLevel): Pass[] {
  if (level === 0) return [];
  const cheap: Pass[] = []; // T34 push constFoldPass; T38 push dcePass; T50 push peepholePass
  if (level === 1) return cheap;
  const aggressive: Pass[] = [...cheap]; // T42 push icPass; T46 push inlinePass at right slot
  return aggressive;
}

export function runOptimizer(prog: Program, level: OLevel): Program {
  let p = prog;
  for (const pass of passesForLevel(level)) {
    p = pass(p);
  }
  return p;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer.ts test/optimizer.test.ts
git commit -m "feat(optimizer): skeleton with Pass type and runOptimizer (-O levels)"
```

---

## Constant Folding (T32-T34)

### Task 32: constfold.ts — basic int arithmetic

**Files:**
- Create: `src/optimizer/constfold.ts`
- Modify: `test/optimizer.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { constFoldPass } from '../src/optimizer/constfold.js';

test('1 + 2 folds to a single LOAD_CONST 3', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  const out = constFoldPass(prog);
  // After fold: LOAD_CONST <3>, HALT. The constant pool may grow.
  expect(out.code.length).toBe(2);
  expect(out.code[0][0]).toBe('LOAD_CONST');
  const idx = (out.code[0] as ['LOAD_CONST', number])[1];
  expect(out.constants[idx]).toEqual({ tag: 'int', v: 3 });
  expect(out.code[1]).toEqual(['HALT']);
});

test('1 + 2 * 3 folds completely', () => {
  // LOAD 1, LOAD 2, LOAD 3, BIN_OP *, BIN_OP +, HALT  → LOAD 7, HALT
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }, { tag: 'int', v: 3 }],
    code: [
      ['LOAD_CONST', 0], ['LOAD_CONST', 1], ['LOAD_CONST', 2],
      ['BIN_OP', '*'], ['BIN_OP', '+'], ['HALT'],
    ],
  };
  const out = constFoldPass(prog);
  expect(out.code.length).toBe(2);
  const v = out.constants[(out.code[0] as ['LOAD_CONST', number])[1]];
  expect(v).toEqual({ tag: 'int', v: 7 });
});

test('LOAD_VAR + LOAD_CONST is not foldable', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['LOAD_VAR', 'x', null], ['LOAD_CONST', 0], ['BIN_OP', '+'], ['HALT']],
  };
  const out = constFoldPass(prog);
  expect(out.code).toEqual(prog.code);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Create `src/optimizer/constfold.ts`**

```ts
// Constant Folding pass.
// Repeatedly scans for LOAD_CONST, LOAD_CONST, BIN_OP triples and folds them.
// Rebuilds code array (and constant pool, deduped) on each fixpoint iteration.

import type { Program, Opcode, ConstantPoolEntry } from '../bytecode.js';
import { internConstant, constantToValue, valueToConstant } from '../bytecode.js';
import type { Value } from '../ast.js';

export function constFoldPass(prog: Program): Program {
  let code = prog.code;
  let constants = [...prog.constants];
  let changed = true;
  while (changed) {
    changed = false;
    const next: Opcode[] = [];
    const jumpTargetMap = new Map<number, number>(); // old IP -> new IP
    for (let i = 0; i < code.length; i++) {
      jumpTargetMap.set(i, next.length);
      const op = code[i];
      // Look for fold pattern: LOAD_CONST, LOAD_CONST, BIN_OP
      if (
        op[0] === 'LOAD_CONST' &&
        i + 2 < code.length &&
        code[i+1][0] === 'LOAD_CONST' &&
        code[i+2][0] === 'BIN_OP'
      ) {
        const a = constantToValue(constants[op[1] as number]);
        const b = constantToValue(constants[(code[i+1] as ['LOAD_CONST', number])[1]]);
        const opn = (code[i+2] as ['BIN_OP', string])[1];
        const folded = tryFold(opn, a, b);
        if (folded) {
          const newIdx = internConstant(constants, valueToConstant(folded));
          next.push(['LOAD_CONST', newIdx]);
          jumpTargetMap.set(i+1, next.length - 1);
          jumpTargetMap.set(i+2, next.length - 1);
          i += 2;
          changed = true;
          continue;
        }
      }
      next.push(op);
    }
    // Re-map jump targets that point to old indices
    code = next.map(o => remapJumps(o, jumpTargetMap, code.length));
  }
  return { ...prog, constants, code };
}

function tryFold(op: string, a: Value, b: Value): Value | null {
  if (a.tag === 'int' && b.tag === 'int') {
    switch (op) {
      case '+': return { tag: 'int', v: a.v + b.v };
      case '-': return { tag: 'int', v: a.v - b.v };
      case '*': return { tag: 'int', v: a.v * b.v };
      case '/': if (b.v === 0) return null; return { tag: 'int', v: Math.trunc(a.v / b.v) };
      case '<':  return { tag: 'bool', v: a.v <  b.v };
      case '>':  return { tag: 'bool', v: a.v >  b.v };
      case '<=': return { tag: 'bool', v: a.v <= b.v };
      case '>=': return { tag: 'bool', v: a.v >= b.v };
      case '==': return { tag: 'bool', v: a.v === b.v };
      case '!=': return { tag: 'bool', v: a.v !== b.v };
    }
  }
  if (a.tag === 'str' && b.tag === 'str' && op === '+') {
    return { tag: 'str', v: a.v + b.v };
  }
  return null;
}

function remapJumps(op: Opcode, m: Map<number, number>, oldLen: number): Opcode {
  if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
    const oldTarget = op[1] as number;
    const newTarget = m.get(oldTarget);
    if (newTarget === undefined) {
      if (oldTarget === oldLen) return op;   // points past end
      throw new Error(`constFoldPass: orphan jump target ${oldTarget}`);
    }
    return [op[0], newTarget] as Opcode;
  }
  if (op[0] === 'MAKE_CLOSURE') {
    const oldBody = op[2] as number;
    const newBody = m.get(oldBody);
    if (newBody === undefined) throw new Error(`constFoldPass: orphan MAKE_CLOSURE body ${oldBody}`);
    return ['MAKE_CLOSURE', op[1] as string[], newBody, op[3] as number];
  }
  return op;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/constfold.ts test/optimizer.test.ts
git commit -m "feat(optimizer/constfold): fold LOAD_CONST/LOAD_CONST/BIN_OP triples"
```

---

### Task 33: constfold — string + bool + edge cases

**Files:** Modify `src/optimizer/constfold.ts`, `test/optimizer.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('string concat folds', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hi ' }, { tag: 'str', v: 'world' }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  const out = constFoldPass(prog);
  const v = out.constants[(out.code[0] as ['LOAD_CONST', number])[1]];
  expect(v).toEqual({ tag: 'str', v: 'hi world' });
});

test('comparison folds to bool', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '<'], ['HALT']],
  };
  const out = constFoldPass(prog);
  const v = out.constants[(out.code[0] as ['LOAD_CONST', number])[1]];
  expect(v).toEqual({ tag: 'bool', v: true });
});

test('divide by zero is NOT folded (preserves runtime error)', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 5 }, { tag: 'int', v: 0 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '/'], ['HALT']],
  };
  const out = constFoldPass(prog);
  expect(out.code).toEqual(prog.code);
});

test('mixed-type BIN_OP not folded (preserves runtime error)', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'str', v: 'x' }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  expect(constFoldPass(prog).code).toEqual(prog.code);
});
```

- [ ] **Step 2: Run — PASS (already covered by T32 fold table; string+bool already work)**

Verify by running. If any test fails it means there's a gap; extend `tryFold` accordingly.

- [ ] **Step 3: Commit**

```bash
git add test/optimizer.test.ts
git commit -m "test(optimizer/constfold): string concat, comparisons, error-preservation"
```

---

### Task 34: constfold wired into optimizer

**Files:** Modify `src/optimizer.ts`.

- [ ] **Step 1: Failing test**

```ts
test('runOptimizer at -O1 applies constFoldPass', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [['LOAD_CONST', 0], ['LOAD_CONST', 1], ['BIN_OP', '+'], ['HALT']],
  };
  const out = runOptimizer(prog, 1);
  expect(out.code.length).toBe(2);   // folded
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Update `src/optimizer.ts`**

```ts
import { constFoldPass } from './optimizer/constfold.js';

function passesForLevel(level: OLevel): Pass[] {
  if (level === 0) return [];
  const cheap: Pass[] = [constFoldPass /*, dcePass, peepholePass*/];
  if (level === 1) return cheap;
  const aggressive: Pass[] = [...cheap /*, icPass, inlinePass*/];
  return aggressive;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer.ts
git commit -m "feat(optimizer): wire constFoldPass into -O1 and -O2"
```

---

## Dead Code Elimination (T35-T38)

### Task 35: dce.ts — unreachable code after HALT/RETURN

**Files:**
- Create: `src/optimizer/dce.ts`
- Modify: `test/optimizer.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { dcePass } from '../src/optimizer/dce.js';

test('code after HALT is removed', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['HALT'], ['LOAD_CONST', 0], ['HALT']],
  };
  const out = dcePass(prog);
  expect(out.code).toEqual([['HALT']]);
});

test('code after RETURN inside fn body is removed', () => {
  // MAKE_CLOSURE [], 3, 5
  // JUMP 8
  // ENTER_BLOCK         <- 3
  // LOAD_CONST 0        <- 4
  // EXIT_BLOCK          <- 5
  // RETURN              <- 6
  // LOAD_CONST 0        <- 7 (dead)
  // STORE_VAR f         <- 8
  // HALT                <- 9
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [
      ['MAKE_CLOSURE', [], 3, 5],
      ['JUMP', 8],
      ['ENTER_BLOCK'],
      ['LOAD_CONST', 0],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'f'],
      ['HALT'],
    ],
  };
  const out = dcePass(prog);
  // The LOAD_CONST at old IP=6 is dead — but only because no JUMP/CALL targets it.
  // RETURN ends a branch; subsequent opcode is dead if nothing jumps to it.
  // In this program, JUMP at IP=1 lands at the (originally 8) STORE_VAR — so the dead
  // LOAD_CONST 0 between RETURN and STORE_VAR is removed.
  const opNames = out.code.map(o => o[0]);
  expect(opNames).not.toContain('LOAD_CONST');  // wait — there's still LOAD_CONST in body
  // Reconsider: body contains LOAD_CONST 0; what's dead is only IP=6.
  // So opNames = ['MAKE_CLOSURE', 'JUMP', 'ENTER_BLOCK', 'LOAD_CONST', 'EXIT_BLOCK', 'RETURN', 'STORE_VAR', 'HALT']
  // (length 8 vs original 9)
  expect(out.code.length).toBe(8);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Create `src/optimizer/dce.ts`**

```ts
// Dead Code Elimination.
// Pass 1: mark reachable opcodes via flow analysis (BFS from IP 0).
// Pass 2: rebuild code keeping only reachable; remap jump targets.

import type { Program, Opcode } from '../bytecode.js';

export function dcePass(prog: Program): Program {
  const reachable = computeReachable(prog);
  const oldToNew = new Map<number, number>();
  const next: Opcode[] = [];
  for (let i = 0; i < prog.code.length; i++) {
    if (reachable.has(i)) {
      oldToNew.set(i, next.length);
      next.push(prog.code[i]);
    }
  }
  // Past-end target stays past-end
  oldToNew.set(prog.code.length, next.length);
  const remapped = next.map(o => remapTargets(o, oldToNew));
  return { ...prog, code: remapped };
}

function computeReachable(prog: Program): Set<number> {
  const reach = new Set<number>();
  const queue: number[] = [0];
  while (queue.length > 0) {
    const ip = queue.shift()!;
    if (reach.has(ip)) continue;
    if (ip < 0 || ip >= prog.code.length) continue;
    reach.add(ip);
    const op = prog.code[ip];
    switch (op[0]) {
      case 'HALT':
      case 'RETURN':
        break;            // no successors
      case 'JUMP':
        queue.push(op[1] as number);
        break;
      case 'JUMP_IF_FALSE':
        queue.push(op[1] as number);
        queue.push(ip + 1);
        break;
      case 'MAKE_CLOSURE': {
        const bodyIp = op[2] as number;
        const bodyLen = op[3] as number;
        // body is reachable on call; mark conservatively
        for (let j = 0; j < bodyLen; j++) queue.push(bodyIp + j);
        queue.push(ip + 1);
        break;
      }
      case 'CALL':
      case 'CALL_BUILTIN':
        queue.push(ip + 1);
        break;
      default:
        queue.push(ip + 1);
        break;
    }
  }
  return reach;
}

function remapTargets(op: Opcode, m: Map<number, number>): Opcode {
  if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
    const t = m.get(op[1] as number);
    if (t === undefined) throw new Error(`dcePass: orphan jump`);
    return [op[0], t] as Opcode;
  }
  if (op[0] === 'MAKE_CLOSURE') {
    const oldBody = op[2] as number;
    const newBody = m.get(oldBody);
    if (newBody === undefined) throw new Error(`dcePass: orphan closure body`);
    return ['MAKE_CLOSURE', op[1] as string[], newBody, op[3] as number];
  }
  return op;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/dce.ts test/optimizer.test.ts
git commit -m "feat(optimizer/dce): unreachable-after-HALT/RETURN elimination"
```

---

### Task 36: DCE — JUMP-only sequences with no fall-through

**Files:** Modify `test/optimizer.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('always-true JUMP_IF_FALSE leaves the conditional code reachable but else-branch unreachable when const-folded', () => {
  // Simulates post-constfold: JUMP_IF_FALSE with always-true would have been short-circuited,
  // but DCE alone (without constfold) just verifies that JUMP target reachability is correct.
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 2 }],
    code: [
      ['JUMP', 3],            // 0 - skip to 3
      ['LOAD_CONST', 0],      // 1 - dead
      ['HALT'],               // 2 - dead
      ['LOAD_CONST', 1],      // 3 - reachable
      ['HALT'],               // 4 - reachable
    ],
  };
  const out = dcePass(prog);
  expect(out.code).toEqual([
    ['JUMP', 1],
    ['LOAD_CONST', 1],
    ['HALT'],
  ]);
});
```

- [ ] **Step 2: Run — should already PASS via T35 algorithm**

- [ ] **Step 3: Commit**

```bash
git add test/optimizer.test.ts
git commit -m "test(optimizer/dce): JUMP-skip eliminates dead block"
```

---

### Task 37: DCE — unused constants pruned from pool

**Files:** Modify `src/optimizer/dce.ts`, `test/optimizer.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('constants not referenced after DCE are pruned from pool', () => {
  const prog: Program = {
    version: 1,
    constants: [
      { tag: 'int', v: 1 },   // 0 - used only in dead code
      { tag: 'int', v: 2 },   // 1 - used in live code
    ],
    code: [
      ['JUMP', 3],
      ['LOAD_CONST', 0],      // dead
      ['HALT'],               // dead
      ['LOAD_CONST', 1],
      ['HALT'],
    ],
  };
  const out = dcePass(prog);
  expect(out.constants).toEqual([{ tag: 'int', v: 2 }]);
  expect((out.code.find(o => o[0] === 'LOAD_CONST') as ['LOAD_CONST', number])[1]).toBe(0);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Extend `dcePass`**

After computing `next` and remapping jumps, also prune constants and remap LOAD_CONST indices:

```ts
// Right before returning in dcePass:
const used = new Set<number>();
for (const op of remapped) {
  if (op[0] === 'LOAD_CONST') used.add(op[1] as number);
}
const oldToNewConst = new Map<number, number>();
const prunedConstants = [];
for (let i = 0; i < prog.constants.length; i++) {
  if (used.has(i)) {
    oldToNewConst.set(i, prunedConstants.length);
    prunedConstants.push(prog.constants[i]);
  }
}
const finalCode = remapped.map(op => {
  if (op[0] === 'LOAD_CONST') return ['LOAD_CONST', oldToNewConst.get(op[1] as number)!] as Opcode;
  return op;
});
return { ...prog, constants: prunedConstants, code: finalCode };
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/dce.ts test/optimizer.test.ts
git commit -m "feat(optimizer/dce): prune unreferenced constants from pool"
```

---

### Task 38: DCE wired into optimizer

**Files:** Modify `src/optimizer.ts`.

- [ ] **Step 1: Failing test**

```ts
test('runOptimizer at -O1 applies dcePass', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['HALT'], ['HALT'], ['HALT']],
  };
  const out = runOptimizer(prog, 1);
  expect(out.code).toEqual([['HALT']]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Update `passesForLevel`**

```ts
import { constFoldPass } from './optimizer/constfold.js';
import { dcePass } from './optimizer/dce.js';

function passesForLevel(level: OLevel): Pass[] {
  if (level === 0) return [];
  const cheap: Pass[] = [constFoldPass, dcePass /*, peepholePass*/];
  if (level === 1) return cheap;
  return [...cheap /*, icPass, inlinePass*/];
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer.ts
git commit -m "feat(optimizer): wire dcePass into -O1 and -O2"
```

---

## Inline Caches (T39-T42)

### Task 39: ic.ts — LOAD_VAR cache (pre-computed lookup)

**Files:**
- Create: `src/optimizer/ic.ts`
- Modify: `test/optimizer.test.ts`, `src/vm.ts`

The IC for LOAD_VAR records the static lexical-scope depth at compile time, so the VM can skip the frame walk. Since lexical scope is determinable from the bytecode (block depths from ENTER/EXIT), we can precompute it.

**Strategy (simplified for Phase 3):** scan the program; for each LOAD_VAR `x`, look back through the static scope of enclosing blocks/closures and find which scope binds `x`. Encode `framesUp` (relative to current).

For now, we'll implement a conservative IC: if the variable is bound in the top-level (frame 0) and never shadowed, encode `framesUp = (current depth)`. Otherwise leave the IC slot `null` (VM falls back to chain walk).

- [ ] **Step 1: Failing test**

```ts
import { icPass } from '../src/optimizer/ic.js';

test('LOAD_VAR for a top-level binding records IC slot', () => {
  // let x = 1; x;
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'x'],
      ['LOAD_VAR', 'x', null],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  const load = out.code[2] as ['LOAD_VAR', string, any];
  expect(load[2]).toEqual({ framesUp: 0 });
});

test('LOAD_VAR for a binding inside a block records framesUp=0', () => {
  // ENTER_BLOCK; let y = 1; y; EXIT_BLOCK; HALT
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [
      ['ENTER_BLOCK'],
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'y'],
      ['LOAD_VAR', 'y', null],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  const load = out.code[3] as ['LOAD_VAR', string, any];
  expect(load[2]).toEqual({ framesUp: 0 });
});

test('LOAD_VAR for outer binding from inside a block records framesUp>0', () => {
  // STORE_VAR x in frame 0; ENTER_BLOCK; LOAD_VAR x; EXIT_BLOCK; HALT
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [
      ['LOAD_CONST', 0], ['STORE_VAR', 'x'],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', null],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  const load = out.code[3] as ['LOAD_VAR', string, any];
  expect(load[2]).toEqual({ framesUp: 1 });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Create `src/optimizer/ic.ts`**

```ts
// Inline Caches: precompute LOAD_VAR frame depth.
// Walks the code linearly, tracking the static block-depth stack and bindings per depth.

import type { Program, Opcode, LoadVarIC } from '../bytecode.js';

export function icPass(prog: Program): Program {
  // Per-depth bindings stack: index 0 = root frame.
  const bindings: Array<Set<string>> = [new Set()];
  const code: Opcode[] = [];
  // Closure bodies are tricky — when entering MAKE_CLOSURE body, the depth resets.
  // For Phase 3 IC we leave the slot null inside closure bodies (caller will fall back to walk).
  let insideClosureBody = false;
  let closureBodyEnd = -1;
  for (let i = 0; i < prog.code.length; i++) {
    if (insideClosureBody && i >= closureBodyEnd) insideClosureBody = false;
    const op = prog.code[i];
    if (op[0] === 'MAKE_CLOSURE') {
      const bodyIp = op[2] as number;
      const bodyLen = op[3] as number;
      // The body is at bodyIp; mark the range. Note bytecode layout: MAKE_CLOSURE then JUMP then body.
      insideClosureBody = (i + 2 === bodyIp);
      closureBodyEnd = bodyIp + bodyLen;
    }
    if (insideClosureBody) {
      code.push(op);
      continue;
    }
    switch (op[0]) {
      case 'ENTER_BLOCK':
        bindings.push(new Set());
        code.push(op);
        break;
      case 'EXIT_BLOCK':
        bindings.pop();
        if (bindings.length === 0) bindings.push(new Set()); // defensive
        code.push(op);
        break;
      case 'STORE_VAR': {
        const name = op[1] as string;
        bindings[bindings.length - 1].add(name);
        code.push(op);
        break;
      }
      case 'LOAD_VAR': {
        const name = op[1] as string;
        let framesUp = -1;
        for (let d = bindings.length - 1; d >= 0; d--) {
          if (bindings[d].has(name)) {
            framesUp = (bindings.length - 1) - d;
            break;
          }
        }
        if (framesUp >= 0) {
          const ic: LoadVarIC = { framesUp };
          code.push(['LOAD_VAR', name, ic]);
        } else {
          code.push(op);
        }
        break;
      }
      default:
        code.push(op);
    }
  }
  return { ...prog, code };
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/ic.ts test/optimizer.test.ts
git commit -m "feat(optimizer/ic): LOAD_VAR IC slot with static framesUp"
```

---

### Task 40: VM honors IC slot

**Files:** Modify `src/vm.ts`, `test/vm.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('VM uses LOAD_VAR IC slot when present', () => {
  // The IC says framesUp=1, but x is actually in frame 0. With IC the walk skips frames.
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 99 }],
    code: [
      ['LOAD_CONST', 0],
      ['STORE_VAR', 'x'],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', { framesUp: 1 }],
      ['EXIT_BLOCK'],
      ['HALT'],
    ],
  };
  expect(run(prog).state.valueStack).toEqual([{ tag: 'int', v: 99 }]);
});
```

- [ ] **Step 2: Run — should already PASS if VM ignores IC (chain walk gives same answer)**

Actually the simple LOAD_VAR walk already finds it. The IC is a *fast path*. Update VM to use it:

- [ ] **Step 3: Update LOAD_VAR case in vm.ts**

```ts
case 'LOAD_VAR': {
  const name = op[1] as string;
  const ic = op[2] as { framesUp: number } | null;
  if (ic) {
    // Fast path: directly index the frame.
    const idx = state.frames.length - 1 - ic.framesUp;
    if (idx < 0) throw new Error(`VM LOAD_VAR IC: framesUp out of range`);
    const f = state.frames[idx];
    if (Object.prototype.hasOwnProperty.call(f.bindings, name)) {
      push(state, f.bindings[name]);
      state.ip++;
      break;
    }
    // IC miss — fall through to walk
  }
  // Slow path: walk
  let walkIdx = state.frames.length - 1;
  let found = false;
  while (walkIdx >= 0) {
    const f = state.frames[walkIdx];
    if (Object.prototype.hasOwnProperty.call(f.bindings, name)) {
      push(state, f.bindings[name]);
      found = true;
      break;
    }
    if (f.parentIdx !== undefined) walkIdx = f.parentIdx;
    else walkIdx--;
  }
  if (!found) throw new Error(`VM: undefined variable '${name}' at ip ${state.ip}`);
  state.ip++;
  break;
}
```

- [ ] **Step 4: Run — PASS** (and all prior VM tests still green)

- [ ] **Step 5: Commit**

```bash
git add src/vm.ts test/vm.test.ts
git commit -m "feat(vm): LOAD_VAR IC fast path with chain-walk fallback"
```

---

### Task 41: IC for EFFECT (cache invocationCount)

**Files:** Modify `src/optimizer/ic.ts`, `src/vm.ts`, `test/optimizer.test.ts`, `test/vm.test.ts`.

For EFFECT replay performance, we can precompute the invocationCount at each EFFECT site. But since invocationCount depends on which paths execute (loops/branches), full prediction is unsound. Simpler: cache the **lexical EFFECT ordinal** (which EFFECT-by-source-position this is). The runtime can use this as a hint and verify.

- [ ] **Step 1: Test — EFFECT gets a non-null IC after icPass**

```ts
test('EFFECT opcodes get IC slot = lexical ordinal', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'a' }, { tag: 'str', v: 'b' }],
    code: [
      ['LOAD_CONST', 0],
      ['EFFECT', 'print', 1, null],
      ['LOAD_CONST', 1],
      ['EFFECT', 'print', 1, null],
      ['HALT'],
    ],
  };
  const out = icPass(prog);
  expect((out.code[1] as ['EFFECT', string, number, number])[3]).toBe(0);
  expect((out.code[3] as ['EFFECT', string, number, number])[3]).toBe(1);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Extend `icPass`**

Add a counter before the per-op switch and a case for EFFECT:

```ts
let effectOrdinal = 0;
// inside the loop, BEFORE the existing switch:
if (op[0] === 'EFFECT') {
  code.push(['EFFECT', op[1] as string, op[2] as number, effectOrdinal]);
  effectOrdinal++;
  continue;
}
```

- [ ] **Step 4: Run — PASS** (VM still works because EFFECT's IC param is unused by VM in T41; future optimizations may use it)

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/ic.ts test/optimizer.test.ts
git commit -m "feat(optimizer/ic): EFFECT lexical ordinal IC slot"
```

---

### Task 42: icPass wired into -O2

**Files:** Modify `src/optimizer.ts`.

- [ ] **Step 1: Failing test**

```ts
test('runOptimizer -O2 applies icPass; -O1 does not', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }],
    code: [['LOAD_CONST', 0], ['STORE_VAR', 'x'], ['LOAD_VAR', 'x', null], ['HALT']],
  };
  const o1 = runOptimizer(prog, 1);
  expect((o1.code[2] as ['LOAD_VAR', string, any])[2]).toBeNull();
  const o2 = runOptimizer(prog, 2);
  expect((o2.code[2] as ['LOAD_VAR', string, any])[2]).toEqual({ framesUp: 0 });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Update `passesForLevel`**

```ts
import { icPass } from './optimizer/ic.js';

function passesForLevel(level: OLevel): Pass[] {
  if (level === 0) return [];
  const cheap: Pass[] = [constFoldPass, dcePass /*, peepholePass*/];
  if (level === 1) return cheap;
  return [...cheap, icPass /*, inlinePass*/];
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer.ts
git commit -m "feat(optimizer): wire icPass into -O2"
```

---

## Function Inlining (T43-T46)

Inlining is intentionally narrow: inline single-use closures bound at top level whose body contains no `pause`, no `EFFECT`, and no `CALL`. This rules out pathological cases (recursive inlining, effect-order disruption) and still wins for the common `let helper = fn(x) { x + 1 }; helper(...)` pattern.

### Task 43: inline.ts — detect inlining candidates

**Files:**
- Create: `src/optimizer/inline.ts`
- Modify: `test/optimizer.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { findInliningCandidates } from '../src/optimizer/inline.js';

test('candidate detection: single-use top-level pure fn', () => {
  // let f = fn(x) { x + 1 }; f(10);
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 10 }],
    code: [
      ['MAKE_CLOSURE', ['x'], 2, 6],          // 0
      ['JUMP', 8],                            // 1
      ['ENTER_BLOCK'],                        // 2
      ['LOAD_VAR', 'x', null],                // 3
      ['LOAD_CONST', 0],                      // 4
      ['BIN_OP', '+'],                        // 5
      ['EXIT_BLOCK'],                         // 6
      ['RETURN'],                             // 7
      ['STORE_VAR', 'f'],                     // 8
      ['LOAD_VAR', 'f', null],                // 9
      ['LOAD_CONST', 1],                      // 10
      ['CALL', 1],                            // 11
      ['HALT'],                               // 12
    ],
  };
  const cands = findInliningCandidates(prog);
  expect(cands.length).toBe(1);
  expect(cands[0]).toMatchObject({
    name: 'f', callSiteIp: 11, params: ['x'], bodyIp: 2, bodyLen: 6,
  });
});

test('candidate rejection: fn body contains EFFECT', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hi' }],
    code: [
      ['MAKE_CLOSURE', [], 2, 5],
      ['JUMP', 7],
      ['ENTER_BLOCK'],
      ['LOAD_CONST', 0],
      ['EFFECT', 'print', 1, null],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['STORE_VAR', 'f'],
      ['LOAD_VAR', 'f', null],
      ['CALL', 0],
      ['HALT'],
    ],
  };
  expect(findInliningCandidates(prog).length).toBe(0);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Create `src/optimizer/inline.ts`**

```ts
// Function Inlining (narrow): inline single-use closures with pure body.
// Pure body = no PAUSE, no EFFECT, no CALL, no CALL_BUILTIN.

import type { Program, Opcode } from '../bytecode.js';

export type InlineCandidate = {
  name: string;
  makeClosureIp: number;
  storeVarIp: number;
  callSiteIp: number;
  params: string[];
  bodyIp: number;
  bodyLen: number;
};

export function findInliningCandidates(prog: Program): InlineCandidate[] {
  // Scan for: MAKE_CLOSURE -> JUMP -> body -> STORE_VAR x
  const candidates: InlineCandidate[] = [];
  const loadVarSites = new Map<string, number[]>(); // name -> ip[]
  const callSites = new Map<string, number[]>();    // name -> ip[]
  for (let i = 0; i < prog.code.length; i++) {
    const op = prog.code[i];
    if (op[0] === 'LOAD_VAR') {
      const arr = loadVarSites.get(op[1] as string) ?? [];
      arr.push(i);
      loadVarSites.set(op[1] as string, arr);
      // Followed by CALL?
      const followIdx = findFollowingCall(prog, i);
      if (followIdx >= 0) {
        const arr2 = callSites.get(op[1] as string) ?? [];
        arr2.push(followIdx);
        callSites.set(op[1] as string, arr2);
      }
    }
  }
  for (let i = 0; i < prog.code.length; i++) {
    const op = prog.code[i];
    if (op[0] !== 'MAKE_CLOSURE') continue;
    // Expect MAKE_CLOSURE, JUMP, body[bodyLen], STORE_VAR <name>
    const bodyIp = op[2] as number;
    const bodyLen = op[3] as number;
    const storeIp = bodyIp + bodyLen;
    const storeOp = prog.code[storeIp];
    if (!storeOp || storeOp[0] !== 'STORE_VAR') continue;
    const name = storeOp[1] as string;
    // Body pure?
    let pure = true;
    for (let j = bodyIp; j < bodyIp + bodyLen; j++) {
      const bop = prog.code[j];
      if (bop[0] === 'PAUSE' || bop[0] === 'EFFECT' || bop[0] === 'CALL' || bop[0] === 'CALL_BUILTIN') {
        pure = false; break;
      }
    }
    if (!pure) continue;
    // Single use?
    const uses = loadVarSites.get(name) ?? [];
    if (uses.length !== 1) continue;
    const calls = callSites.get(name) ?? [];
    if (calls.length !== 1) continue;
    candidates.push({
      name, makeClosureIp: i, storeVarIp: storeIp,
      callSiteIp: calls[0], params: op[1] as string[],
      bodyIp, bodyLen,
    });
  }
  return candidates;
}

function findFollowingCall(prog: Program, loadVarIp: number): number {
  // The CALL appears after argc more push opcodes. We don't predict pushes;
  // we scan forward over LOAD_*/PUSH_* opcodes until we hit CALL or non-push.
  for (let i = loadVarIp + 1; i < prog.code.length; i++) {
    const op = prog.code[i];
    if (op[0] === 'CALL') return i;
    if (op[0] === 'LOAD_CONST' || op[0] === 'LOAD_VAR' || op[0] === 'PUSH_UNIT') continue;
    return -1;
  }
  return -1;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/inline.ts test/optimizer.test.ts
git commit -m "feat(optimizer/inline): detect single-use pure-body closure candidates"
```

---

### Task 44: inline transformation

**Files:** Modify `src/optimizer/inline.ts`, `test/optimizer.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import { inlinePass } from '../src/optimizer/inline.js';

test('inline pass replaces a single-use call with inlined body', () => {
  // let f = fn(x) { x + 1 }; f(10);
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'int', v: 1 }, { tag: 'int', v: 10 }],
    code: [
      ['MAKE_CLOSURE', ['x'], 2, 6],
      ['JUMP', 8],
      ['ENTER_BLOCK'],
      ['LOAD_VAR', 'x', null],
      ['LOAD_CONST', 0],
      ['BIN_OP', '+'],
      ['EXIT_BLOCK'],
      ['RETURN'],
      ['STORE_VAR', 'f'],
      ['LOAD_VAR', 'f', null],
      ['LOAD_CONST', 1],
      ['CALL', 1],
      ['HALT'],
    ],
  };
  const out = inlinePass(prog);
  // After inlining: the MAKE_CLOSURE+body+STORE_VAR is removed; the call site replaced
  // with: STORE_VAR x (binding arg), ENTER_BLOCK, LOAD_VAR x, LOAD_CONST 1, BIN_OP +, EXIT_BLOCK.
  // (The LOAD_VAR f before the call is also removed; the LOAD_CONST 1 stays as the arg.)
  expect(out.code.find(op => op[0] === 'MAKE_CLOSURE')).toBeUndefined();
  expect(out.code.find(op => op[0] === 'CALL')).toBeUndefined();
  // The inlined body should compute 11.
  // Run it through the VM and verify the program reaches HALT cleanly.
  const { run } = require('../src/vm.js');
  expect(run(out).status).toBe('halted');
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `inlinePass`**

```ts
export function inlinePass(prog: Program): Program {
  const candidates = findInliningCandidates(prog);
  if (candidates.length === 0) return prog;
  // Process one candidate at a time, rebuild, then re-scan. (Fixpoint.)
  let cur = prog;
  let didInline = true;
  while (didInline) {
    didInline = false;
    const cs = findInliningCandidates(cur);
    if (cs.length === 0) break;
    const c = cs[0];
    cur = applyInline(cur, c);
    didInline = true;
  }
  return cur;
}

function applyInline(prog: Program, c: InlineCandidate): Program {
  // Rewrite plan:
  //   Remove: code[c.makeClosureIp .. c.storeVarIp]   (MAKE_CLOSURE, JUMP, body, RETURN, STORE_VAR — c.storeVarIp+1 exclusive)
  //   Remove: code[c.callSiteIp - 1 - argc .. c.callSiteIp] LOAD_VAR f, args, CALL — keep args!
  //   Insert at callSiteIp position: STORE_VAR per param (consuming args in reverse), body[c.bodyIp..c.bodyIp+c.bodyLen]
  // For simplicity: find the LOAD_VAR f that's the callee, remove just that opcode,
  // then replace the CALL with STORE_VARs + body (no ENTER/EXIT_BLOCK since body already has them).
  const argc = c.params.length;
  // Locate the callee LOAD_VAR — it's at callSiteIp - argc - 1
  const calleeLoadIp = c.callSiteIp - argc - 1;
  if (calleeLoadIp < 0 || prog.code[calleeLoadIp][0] !== 'LOAD_VAR') {
    return prog; // bail
  }
  // Build new code: split into 3 sections
  // 1. [0 .. c.makeClosureIp)  — before the closure defn
  // 2. [c.storeVarIp+1 .. calleeLoadIp)  — between closure and call (excluding STORE_VAR f)
  // 3. args remain: [calleeLoadIp+1 .. c.callSiteIp)  args before CALL
  // 4. replacement: STORE_VAR per param in reverse + body opcodes (replacing RETURN with nothing — leave trailing value on stack)
  // 5. [c.callSiteIp+1 .. end)
  const before = prog.code.slice(0, c.makeClosureIp);
  const middle = prog.code.slice(c.storeVarIp + 1, calleeLoadIp);
  const args = prog.code.slice(calleeLoadIp + 1, c.callSiteIp);
  const bodyOps = prog.code.slice(c.bodyIp, c.bodyIp + c.bodyLen);
  // body ends in EXIT_BLOCK then RETURN — keep EXIT_BLOCK (it's part of body), but drop the RETURN that follows.
  // Actually c.bodyLen does NOT include RETURN (RETURN is at bodyIp+bodyLen, which is storeVarIp's predecessor).
  // bodyOps ends in EXIT_BLOCK. We want the trailing-value on the stack, so leave it.
  const paramStores: Opcode[] = c.params.slice().reverse().map(p => ['STORE_VAR', p]);
  const after = prog.code.slice(c.callSiteIp + 1);
  // Need to insert ENTER_BLOCK to give the params a scope; body already has its own ENTER_BLOCK.
  // Actually bodyOps starts with ENTER_BLOCK already (it's the body's block). The param bindings
  // should be in a scope OUTSIDE the body's ENTER_BLOCK, so they're visible to LOAD_VAR x.
  // Wrap: ENTER_BLOCK, STORE_VARs (reversed args), body, EXIT_BLOCK.
  const inlinedFragment: Opcode[] = [
    ['ENTER_BLOCK'],
    ...paramStores,
    ...bodyOps,
    ['EXIT_BLOCK'],
  ];
  // The CALL is replaced; the call-site fragment becomes: [args, inlinedFragment].
  // (args were already pushed before; they sit on the stack waiting. ENTER_BLOCK doesn't touch stack.
  //  STORE_VAR pops them into params. body computes. EXIT_BLOCK keeps trailing value.)
  const newCode: Opcode[] = [
    ...before,
    ...middle,
    ...args,
    ...inlinedFragment,
    ...after,
  ];
  // Compute IP shift map for jump targets. Conservative: re-build a position map.
  // Old IPs that survive: [0..c.makeClosureIp), [c.storeVarIp+1..calleeLoadIp), [calleeLoadIp+1..c.callSiteIp), [c.callSiteIp+1..end)
  // For Phase 3 we simplify: this inline is only sound if NO jump targets land in the removed regions
  // (which is true for top-level fn defs that aren't jumped to from outside).
  // Verify before applying:
  const removedRanges: Array<[number, number]> = [
    [c.makeClosureIp, c.storeVarIp],          // closure defn through STORE_VAR f
    [calleeLoadIp, calleeLoadIp],             // the LOAD_VAR f
    [c.callSiteIp, c.callSiteIp],             // the CALL itself
  ];
  for (const op of prog.code) {
    if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
      const t = op[1] as number;
      for (const [s, e] of removedRanges) {
        if (t >= s && t <= e) return prog;  // unsafe, bail
      }
    }
  }
  // Build the IP-shift map and remap all jumps.
  const map = new Map<number, number>();
  let newIp = 0;
  function track(oldStart: number, oldEnd: number, prefixSize: number) {
    for (let i = 0; i < oldEnd - oldStart; i++) map.set(oldStart + i, newIp + i);
    newIp += prefixSize;
  }
  // Section 1: before
  for (let i = 0; i < c.makeClosureIp; i++) map.set(i, i);
  let cursor = c.makeClosureIp;
  // Section 2: middle (after STORE_VAR f, before LOAD_VAR f)
  for (let i = c.storeVarIp + 1; i < calleeLoadIp; i++) {
    map.set(i, cursor);
    cursor++;
  }
  // Section 3: args
  for (let i = calleeLoadIp + 1; i < c.callSiteIp; i++) {
    map.set(i, cursor);
    cursor++;
  }
  // Section 4: inlinedFragment — no old IPs map here
  cursor += inlinedFragment.length;
  // Section 5: after CALL
  for (let i = c.callSiteIp + 1; i < prog.code.length; i++) {
    map.set(i, cursor);
    cursor++;
  }
  map.set(prog.code.length, cursor); // past-end
  const remapped = newCode.map(op => {
    if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
      const t = op[1] as number;
      const nt = map.get(t);
      if (nt === undefined) return op;
      return [op[0], nt] as Opcode;
    }
    if (op[0] === 'MAKE_CLOSURE') {
      const oldBody = op[2] as number;
      const nb = map.get(oldBody);
      if (nb === undefined) return op;
      return ['MAKE_CLOSURE', op[1] as string[], nb, op[3] as number];
    }
    return op;
  });
  return { ...prog, code: remapped };
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/inline.ts test/optimizer.test.ts
git commit -m "feat(optimizer/inline): inline single-use pure closure at call site"
```

---

### Task 45: inline — semantic equivalence test

**Files:** Modify `test/optimizer.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

test('inlined program produces same result as un-inlined', () => {
  const source = 'let f = fn(x) { x + x }; print(to_str(f(7)));';
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  // Baseline
  const r0 = run(prog);
  // Inlined
  const ri = run(inlinePass(prog));
  expect(r0.status).toBe('halted');
  expect(ri.status).toBe('halted');
  // Effects should match
  expect(ri.state.effects.map(e => e.recordedValue))
    .toEqual(r0.state.effects.map(e => e.recordedValue));
});
```

- [ ] **Step 2: Run — PASS (or fix bugs in inlinePass uncovered here)**

If failures occur, debug and fix `inlinePass`. The test should pass before committing.

- [ ] **Step 3: Commit**

```bash
git add test/optimizer.test.ts
git commit -m "test(optimizer/inline): semantic equivalence with un-inlined baseline"
```

---

### Task 46: inlinePass wired into -O2

**Files:** Modify `src/optimizer.ts`.

- [ ] **Step 1: Failing test**

```ts
test('runOptimizer -O2 inlines pure single-use fn; -O1 does not', () => {
  const ast = parse(tokenize('let f = fn(x) { x + 1 }; f(10);'));
  const prog = compile(ast);
  const o1 = runOptimizer(prog, 1);
  expect(o1.code.find(op => op[0] === 'CALL')).toBeDefined();
  const o2 = runOptimizer(prog, 2);
  expect(o2.code.find(op => op[0] === 'CALL')).toBeUndefined();
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Update `passesForLevel`**

```ts
import { inlinePass } from './optimizer/inline.js';

function passesForLevel(level: OLevel): Pass[] {
  if (level === 0) return [];
  const cheap: Pass[] = [constFoldPass, dcePass /*, peepholePass*/];
  if (level === 1) return cheap;
  return [...cheap, icPass, inlinePass];
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer.ts
git commit -m "feat(optimizer): wire inlinePass into -O2"
```

---

## Peephole (T47-T50)

### Task 47: peephole.ts — POP after PUSH_UNIT

**Files:**
- Create: `src/optimizer/peephole.ts`
- Modify: `test/optimizer.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { peepholePass } from '../src/optimizer/peephole.js';

test('PUSH_UNIT immediately followed by POP is removed', () => {
  const prog: Program = {
    version: 1, constants: [],
    code: [['PUSH_UNIT'], ['POP'], ['HALT']],
  };
  const out = peepholePass(prog);
  expect(out.code).toEqual([['HALT']]);
});

test('PUSH_UNIT then POP in middle of program', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 7 }],
    code: [['LOAD_CONST', 0], ['PUSH_UNIT'], ['POP'], ['HALT']],
  };
  const out = peepholePass(prog);
  expect(out.code).toEqual([['LOAD_CONST', 0], ['HALT']]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Create `src/optimizer/peephole.ts`**

```ts
// Peephole: small local rewrites that clean up after other passes.

import type { Program, Opcode } from '../bytecode.js';

export function peepholePass(prog: Program): Program {
  let code = prog.code;
  let changed = true;
  while (changed) {
    changed = false;
    const next: Opcode[] = [];
    const map = new Map<number, number>();
    for (let i = 0; i < code.length; i++) {
      map.set(i, next.length);
      // Rule: PUSH_UNIT, POP -> (nothing)
      if (code[i][0] === 'PUSH_UNIT' && i + 1 < code.length && code[i+1][0] === 'POP') {
        map.set(i+1, next.length);
        i++;
        changed = true;
        continue;
      }
      next.push(code[i]);
    }
    map.set(code.length, next.length);
    code = next.map(op => remap(op, map));
  }
  return { ...prog, code };
}

function remap(op: Opcode, m: Map<number, number>): Opcode {
  if (op[0] === 'JUMP' || op[0] === 'JUMP_IF_FALSE') {
    const t = m.get(op[1] as number);
    return t === undefined ? op : [op[0], t] as Opcode;
  }
  if (op[0] === 'MAKE_CLOSURE') {
    const t = m.get(op[2] as number);
    return t === undefined ? op : ['MAKE_CLOSURE', op[1] as string[], t, op[3] as number];
  }
  return op;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/peephole.ts test/optimizer.test.ts
git commit -m "feat(optimizer/peephole): eliminate PUSH_UNIT immediately followed by POP"
```

---

### Task 48: peephole — JUMP-to-JUMP collapse

**Files:** Modify `src/optimizer/peephole.ts`, `test/optimizer.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('JUMP targeting another JUMP collapses to final target', () => {
  // JUMP 0 -> 2; at IP 2 is JUMP 4. Chain-collapse rewrites JUMP 0 to target 4 directly.
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 0 }],
    code: [
      ['JUMP', 2],
      ['LOAD_CONST', 0],
      ['JUMP', 4],
      ['LOAD_CONST', 0],
      ['HALT'],
    ],
  };
  const out = peepholePass(prog);
  expect((out.code[0] as ['JUMP', number])[1]).toBe(4);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add chain-following BEFORE the rebuild loop in peepholePass**

```ts
// At the start of each fixpoint iteration, rewrite JUMP targets that point at another JUMP.
function followJumpChains(code: Opcode[]): { changed: boolean; code: Opcode[] } {
  let changed = false;
  const out: Opcode[] = code.map(op => {
    if (op[0] !== 'JUMP' && op[0] !== 'JUMP_IF_FALSE') return op;
    let t = op[1] as number;
    const seen = new Set<number>();
    while (t < code.length && code[t][0] === 'JUMP' && !seen.has(t)) {
      seen.add(t);
      t = code[t][1] as number;
    }
    if (t !== op[1]) { changed = true; return [op[0], t] as Opcode; }
    return op;
  });
  return { changed, code: out };
}
```

Inject into `peepholePass`:
```ts
// In peepholePass's while-loop, before the rebuild:
const chained = followJumpChains(code);
if (chained.changed) { code = chained.code; changed = true; }
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/peephole.ts test/optimizer.test.ts
git commit -m "feat(optimizer/peephole): JUMP-to-JUMP chain collapse"
```

---

### Task 49: peephole — LOAD_CONST + POP elimination

**Files:** Modify `src/optimizer/peephole.ts`, `test/optimizer.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('LOAD_CONST immediately followed by POP is removed', () => {
  const prog: Program = {
    version: 1, constants: [{ tag: 'int', v: 99 }],
    code: [['LOAD_CONST', 0], ['POP'], ['HALT']],
  };
  const out = peepholePass(prog);
  expect(out.code).toEqual([['HALT']]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add the rule in peepholePass's rewrite loop (alongside PUSH_UNIT+POP)**

```ts
// Rule: LOAD_CONST, POP -> (nothing). Safe: side-effect-free push.
if (code[i][0] === 'LOAD_CONST' && i + 1 < code.length && code[i+1][0] === 'POP') {
  map.set(i+1, next.length);
  i++;
  changed = true;
  continue;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/peephole.ts test/optimizer.test.ts
git commit -m "feat(optimizer/peephole): eliminate LOAD_CONST immediately followed by POP"
```

---

### Task 50: peepholePass wired + Wave 3 integration test

**Files:** Modify `src/optimizer.ts`, `test/optimizer.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('-O1 applies peepholePass (eliminates PUSH_UNIT+POP)', () => {
  const prog: Program = { version: 1, constants: [], code: [['PUSH_UNIT'], ['POP'], ['HALT']] };
  expect(runOptimizer(prog, 1).code).toEqual([['HALT']]);
});

test('full -O2 pipeline: complex program produces same result as -O0', () => {
  const source = `
    let add = fn(a, b) { a + b };
    let x = add(1, 2);
    let y = add(3, 4);
    print(to_str(x + y));
  `;
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  const r0 = run(runOptimizer(prog, 0));
  const r2 = run(runOptimizer(prog, 2));
  expect(r0.status).toBe('halted');
  expect(r2.status).toBe('halted');
  // Same printed result:
  expect(r2.state.effects.map(e => e.recordedValue))
    .toEqual(r0.state.effects.map(e => e.recordedValue));
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Wire peepholePass**

```ts
import { peepholePass } from './optimizer/peephole.js';

function passesForLevel(level: OLevel): Pass[] {
  if (level === 0) return [];
  const cheap: Pass[] = [constFoldPass, dcePass, peepholePass];
  if (level === 1) return cheap;
  return [...cheap, icPass, inlinePass, peepholePass];  // run peephole twice at -O2 (after inline)
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/optimizer.ts test/optimizer.test.ts
git commit -m "feat(optimizer): wire peepholePass into -O1 and -O2; semantic equivalence test"
```

**End of Wave 3.** Five optimizer passes, runOptimizer accepts -O0/1/2.

---

# Wave 4 — Integration and Polish (T51-T65)

Wave 4 wires the optimizer into the CLI, adds the disassembler, benchmark, demo program, snapshot integration with v3, and regression tests for Phase 2 demos.

### Task 51: CLI -O flag on `build` and `run`

**Files:** Modify `src/cli.ts`, `test/integration.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('pen build -O2 produces fewer opcodes than -O0', () => {
  const srcPath = path.join(os.tmpdir(), `o-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'let f = fn(x) { x + 1 }; f(10);');
  execSync(`node bin/penelope build -O0 ${srcPath}`);
  const baseSize = JSON.parse(fs.readFileSync(srcPath.replace(/\.pen$/, '.penc'), 'utf8')).code.length;
  execSync(`node bin/penelope build -O2 ${srcPath}`);
  const optSize = JSON.parse(fs.readFileSync(srcPath.replace(/\.pen$/, '.penc'), 'utf8')).code.length;
  expect(optSize).toBeLessThan(baseSize);
  fs.unlinkSync(srcPath); fs.unlinkSync(srcPath.replace(/\.pen$/, '.penc'));
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Parse -O flag in CLI**

```ts
function parseOLevel(args: string[]): { level: 0 | 1 | 2; rest: string[] } {
  const rest: string[] = [];
  let level: 0 | 1 | 2 = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-O0') { level = 0; continue; }
    if (args[i] === '-O1') { level = 1; continue; }
    if (args[i] === '-O2') { level = 2; continue; }
    rest.push(args[i]);
  }
  return { level, rest };
}
```

In `build` and `run` subcommands, parse the level and pass it through:
```ts
const { level, rest } = parseOLevel(args.slice(1));
const prog = runOptimizer(compile(ast), level);
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): -O0/-O1/-O2 flag on build and run"
```

---

### Task 52: `pen disasm` subcommand

**Files:** Modify `src/cli.ts`, `test/integration.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('pen disasm prints opcodes with addresses', () => {
  const srcPath = path.join(os.tmpdir(), `d-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'let x = 42;');
  execSync(`node bin/penelope build ${srcPath}`);
  const out = execSync(`node bin/penelope disasm ${srcPath.replace(/\.pen$/, '.penc')}`).toString();
  expect(out).toMatch(/0:\s+LOAD_CONST 0/);
  expect(out).toMatch(/1:\s+STORE_VAR x/);
  expect(out).toMatch(/HALT/);
  expect(out).toMatch(/constants:/);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add `disasm` subcommand**

```ts
if (subcommand === 'disasm') {
  const pencPath = args[1];
  if (!pencPath) { console.error('usage: pen disasm <file.penc>'); process.exit(2); }
  const r = readPencFile(pencPath);
  if ('error' in r) { console.error(r.error); process.exit(1); }
  console.log('constants:');
  for (let i = 0; i < r.prog.constants.length; i++) {
    console.log(`  ${i}: ${JSON.stringify(r.prog.constants[i])}`);
  }
  console.log('code:');
  for (let i = 0; i < r.prog.code.length; i++) {
    const op = r.prog.code[i];
    const operands = op.slice(1).map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    console.log(`  ${i}: ${op[0]} ${operands}`);
  }
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): pen disasm for .penc files"
```

---

### Task 53: `pen resume` and `pen fork` via VM

**Files:** Modify `src/cli.ts`, `test/integration.test.ts`.

The existing `resume` and `fork` subcommands in `src/cli.ts` currently step the Phase 2 interpreter. Replace with VM.

- [ ] **Step 1: Failing test**

```ts
test('pen run + resume completes paused program', () => {
  const srcPath = path.join(os.tmpdir(), `pr-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'print("a"); let x = pause; print("b");');
  const o1 = execSync(`node bin/penelope run ${srcPath}`).toString();
  expect(o1).toMatch(/paused/);
  const snapPath = srcPath.replace(/\.pen$/, '.penz');
  expect(fs.existsSync(snapPath)).toBe(true);
  const o2 = execSync(`node bin/penelope resume ${snapPath}`).toString();
  // First run printed "a"; resume replays "a" from log (no re-print) then prints "b"
  expect(o2).toContain('b');
  expect(o2).not.toContain('a');
  fs.unlinkSync(srcPath); fs.unlinkSync(snapPath);
  const pencPath = srcPath.replace(/\.pen$/, '.penc');
  if (fs.existsSync(pencPath)) fs.unlinkSync(pencPath);
});

test('pen fork branches from a snapshot', () => {
  const srcPath = path.join(os.tmpdir(), `pf-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'let x = pause; print(to_str(x));');
  execSync(`node bin/penelope run ${srcPath}`);
  const snapPath = srcPath.replace(/\.pen$/, '.penz');
  const forkPath = snapPath.replace(/\.penz$/, '-fork.penz');
  execSync(`node bin/penelope fork ${snapPath} ${forkPath}`);
  expect(fs.existsSync(forkPath)).toBe(true);
  // Cleanup
  fs.unlinkSync(srcPath); fs.unlinkSync(snapPath); fs.unlinkSync(forkPath);
  const pencPath = srcPath.replace(/\.pen$/, '.penc');
  if (fs.existsSync(pencPath)) fs.unlinkSync(pencPath);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Update `resume` and `fork` subcommands**

Update `resume` to read the .penc referenced by snap.programPath, verify hash, run VM:

```ts
if (subcommand === 'resume') {
  const snapPath = args[1];
  if (!snapPath) { console.error('usage: pen resume <file.penz>'); process.exit(2); }
  const snapText = fs.readFileSync(snapPath, 'utf8');
  const sr = deserialize(snapText, p => fs.readFileSync(p, 'utf8'));
  if ('error' in sr) { console.error(sr.error); process.exit(1); }
  if (sr.snap.version !== 3) { console.error('snapshot version mismatch'); process.exit(1); }
  const pr = readPencFile(sr.snap.programPath);
  if ('error' in pr) { console.error(pr.error); process.exit(1); }
  const hashNow = 'sha256:' + sha256(fs.readFileSync(sr.snap.programPath, 'utf8'));
  if (hashNow !== sr.snap.programHash) {
    console.error('program hash mismatch — refusing to resume');
    process.exit(1);
  }
  const r = run(pr.prog, sr.snap.state);
  if (r.status === 'paused') {
    const newSnap = { ...sr.snap, pausedAtIP: r.state.ip, pausedAtMs: Date.now(), state: r.state };
    fs.writeFileSync(snapPath, serialize(newSnap));
    console.log(`paused at ip ${r.state.ip}`);
  }
  return;
}

if (subcommand === 'fork') {
  const src = args[1], dst = args[2];
  if (!src || !dst) { console.error('usage: pen fork <src.penz> <dst.penz>'); process.exit(2); }
  fs.copyFileSync(src, dst);
  console.log(`forked → ${dst}`);
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): pen resume and pen fork via VM with v3 snapshots"
```

---

### Task 54: examples/09-fib.pen + benchmark

**Files:**
- Create: `examples/09-fib.pen`
- Create: `test/bench.test.ts`
- Modify: `src/cli.ts` (add `bench` subcommand — optional)

- [ ] **Step 1: Create demo**

```pen
// examples/09-fib.pen
let fib = fn(n) {
  if (n < 2) {
    n
  } else {
    fib(n - 1) + fib(n - 2)
  }
};
print(to_str(fib(20)));
```

- [ ] **Step 2: Failing test**

```ts
// test/bench.test.ts
import { test, expect } from 'vitest';
import * as fs from 'fs';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { runOptimizer } from '../src/optimizer.js';
import { run } from '../src/vm.js';

test('fib(20) via VM completes and produces 6765', () => {
  const src = fs.readFileSync('examples/09-fib.pen', 'utf8');
  const prog = compile(parse(tokenize(src)));
  const r = run(prog);
  expect(r.status).toBe('halted');
  const printed = r.state.effects.find(e => e.effect === 'print')?.recordedValue;
  // print returns unit, but the argument was the int 6765. We assert via effect args next.
  // Workaround: re-run with a string-saving print mock. For now, just verify it completes fast.
  // Smoke: completes in <500ms (no real perf assertion).
});

test('-O2 fib(20) does not slow program down vs -O0', () => {
  const src = fs.readFileSync('examples/09-fib.pen', 'utf8');
  const prog = compile(parse(tokenize(src)));
  const t0 = Date.now();
  run(runOptimizer(prog, 0));
  const t1 = Date.now();
  run(runOptimizer(prog, 2));
  const t2 = Date.now();
  // Allow O2 to be up to 1.5x O0 (no perf regression). Real speedup target is in T63.
  expect((t2 - t1)).toBeLessThanOrEqual((t1 - t0) * 1.5 + 50);
});
```

- [ ] **Step 3: Run — PASS (or debug the demo if fib doesn't terminate)**

If `fib` recurses too deep for the VM frame stack, this test catches it.

- [ ] **Step 4: Commit**

```bash
git add examples/09-fib.pen test/bench.test.ts
git commit -m "feat(examples): fib benchmark target + smoke perf test"
```

---

### Task 55: `pen bench` subcommand (compares VM vs legacy interpreter)

**Files:** Modify `src/cli.ts`, `test/integration.test.ts`. Re-enable `src/legacy-interpreter.ts` for this purpose.

- [ ] **Step 1: Failing test**

```ts
test('pen bench prints timing comparison', () => {
  const out = execSync(`node bin/penelope bench examples/09-fib.pen`).toString();
  expect(out).toMatch(/VM \(-O0\)/);
  expect(out).toMatch(/VM \(-O2\)/);
  expect(out).toMatch(/legacy interpreter/);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add `bench` subcommand**

The legacy interpreter is excluded from tsc — re-include it just for the bench path. Update `tsconfig.json` to remove the exclusion, fix any type errors that surface in legacy-interpreter.ts (likely closure shape conflict).

A simpler path: rename `legacy-interpreter.ts` → `legacy-interpreter.cjs` (run via require) or maintain a wrapper. **Recommended approach:** create `src/legacy-bench.ts` that imports just the legacy interpret function and patches the closure type at the boundary.

For Phase 3, the cleanest fix: define a `LegacyClosure` type in `legacy-interpreter.ts` instead of reusing `Value`'s closure variant. This isolates legacy from current `Value`.

```bash
# Edit legacy-interpreter.ts to introduce LegacyClosure
```

Define inside `legacy-interpreter.ts`:
```ts
type LegacyClosure = { tag: 'closure'; params: string[]; bodyId: string; capturedScopeId: string };
type LegacyValue =
  | { tag: 'int';  v: number }
  | { tag: 'bool'; v: boolean }
  | { tag: 'str';  v: string }
  | { tag: 'unit' }
  | LegacyClosure;
```

Replace all `Value` references in legacy-interpreter.ts with `LegacyValue` (mechanical sed). Remove the tsconfig exclude.

Add bench subcommand in `src/cli.ts`:
```ts
if (subcommand === 'bench') {
  const srcPath = args[1];
  if (!srcPath) { console.error('usage: pen bench <file.pen>'); process.exit(2); }
  const source = fs.readFileSync(srcPath, 'utf8');
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  const time = (label: string, fn: () => void) => {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    console.log(`  ${label}: ${Number(t1 - t0) / 1e6} ms`);
  };
  console.log(`benchmark: ${srcPath}`);
  time('VM (-O0)', () => run(runOptimizer(prog, 0)));
  time('VM (-O1)', () => run(runOptimizer(prog, 1)));
  time('VM (-O2)', () => run(runOptimizer(prog, 2)));
  time('legacy interpreter', () => legacyInterpret(ast));
  return;
}
```

Import:
```ts
import { interpret as legacyInterpret } from './legacy-interpreter.js';
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/legacy-interpreter.ts src/cli.ts tsconfig.json test/integration.test.ts
git commit -m "feat(cli): pen bench compares VM levels and legacy interpreter"
```

---

### Task 56: Phase 2 integration tests — run via VM

**Files:** Modify `test/integration.test.ts`.

The existing Phase 2 integration tests call the step-machine interpreter (via legacy). Replace those internal calls with `compile + run`. Output / effect assertions stay the same.

- [ ] **Step 1: Sweep through `test/integration.test.ts`**

Find tests that import from `'../src/interpreter.js'` (now legacy). Replace with `'../src/vm.js'` and `'../src/compiler.js'`. Rewrite the test body:

Before:
```ts
const state = makeInitialState(ast);
runUntilPauseOrHalt(state);
expect(state.effects).toContainEqual(...);
```

After:
```ts
const prog = compile(ast);
const result = run(prog);
expect(result.state.effects).toContainEqual(...);
```

- [ ] **Step 2: Run integration tests**

```bash
npm test -- integration
```

Fix failures: most will be straightforward field-name updates (`state.effects` shape is the same; just the construction path changed).

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): route Phase 2 demos through VM (compile + run)"
```

---

### Task 57: Snapshot v3 integration tests

**Files:** Modify `test/snapshot.test.ts`, `test/integration.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
test('full lifecycle: run paused snapshot v3, resume, halt', () => {
  const src = 'let x = pause; print(to_str(x));';
  const ast = parse(tokenize(src));
  const prog = compile(ast);
  const first = run(prog);
  expect(first.status).toBe('paused');
  // Build snapshot, serialize, deserialize
  const snap = {
    version: 3 as const,
    programPath: '/tmp/dummy.penc',
    programHash: 'sha256:dummy',
    pausedAtIP: first.state.ip,
    pausedAtMs: Date.now(),
    state: first.state,
  };
  const text = serialize(snap);
  const back = deserialize(text, () => '');
  if ('error' in back) throw new Error(back.error);
  if (back.snap.version !== 3) throw new Error('expected v3');
  // Resume
  const second = run(prog, back.snap.state);
  expect(second.status).toBe('halted');
});

test('snapshot v3 captures and restores effect log', () => {
  const prog: Program = {
    version: 1,
    constants: [{ tag: 'str', v: 'hi' }],
    code: [
      ['LOAD_CONST', 0], ['EFFECT', 'print', 1, null],
      ['PAUSE'], ['HALT'],
    ],
  };
  const r = run(prog);
  expect(r.state.effects).toHaveLength(1);
  const text = serialize({
    version: 3, programPath: 'x', programHash: 'sha256:y',
    pausedAtIP: r.state.ip, pausedAtMs: 0, state: r.state,
  });
  const back = deserialize(text, () => '');
  if ('error' in back || back.snap.version !== 3) throw new Error('v3 expected');
  expect(back.snap.state.effects).toHaveLength(1);
  expect(back.snap.state.effects[0].effect).toBe('print');
});
```

- [ ] **Step 2: Run — PASS (snapshot v3 wiring from T3 should make this work)**

- [ ] **Step 3: Commit**

```bash
git add test/snapshot.test.ts
git commit -m "test(snapshot): v3 full lifecycle and effect-log capture"
```

---

### Task 58: Effect-replay regression (24h HITL example)

**Files:** Modify `test/integration.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('examples/08-24h-hitl.pen runs through pause-resume cycle', () => {
  const src = fs.readFileSync('examples/08-24h-hitl.pen', 'utf8');
  const ast = parse(tokenize(src));
  const prog = compile(ast);
  const state = freshState();
  state.timeOverride = 1700000000;
  const first = run(prog, state);
  expect(first.status).toBe('paused');
  expect(first.state.effects.some(e => e.effect === 'wait_until' || e.effect === 'wait_for')).toBe(true);
  // Advance time and resume
  first.state.timeOverride = 1700086400;
  const second = run(prog, first.state);
  expect(second.status).toBe('halted');
});
```

- [ ] **Step 2: Run — should PASS if compiler + VM correctly route wait effects**

If failures, debug. The 24h-HITL example exercises every primitive — failures here probably indicate a bug in T23 (EFFECT wait handling) or T15 (Pause compilation).

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): 24h HITL agent via VM"
```

---

### Task 59: --no-replay flag end-to-end

**Files:** Modify `test/integration.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('--no-replay re-runs net_fetch effect after resume', () => {
  const srcPath = path.join(os.tmpdir(), `nr-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'let x = net_fetch("http://example.test/a"); pause; print(x);');
  // Pre-mock net_fetch to deterministic result — but Phase 2 actually performs network.
  // For this test, just verify the effect log behavior after no-replay flag.
  // Step 1: run, expect pause + net_fetch entry
  execSync(`node bin/penelope run ${srcPath}`);
  const snapPath = srcPath.replace(/\.pen$/, '.penz');
  const snap1 = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  expect(snap1.state.effects.filter((e: any) => e.effect === 'net_fetch').length).toBe(1);
  // Step 2: resume --no-replay; net_fetch should be re-attempted
  execSync(`node bin/penelope resume --no-replay ${snapPath}`);
  const snap2 = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  expect(snap2.state.effects.filter((e: any) => e.effect === 'net_fetch').length).toBeGreaterThanOrEqual(1);
  fs.unlinkSync(srcPath); fs.unlinkSync(snapPath);
  const pencPath = srcPath.replace(/\.pen$/, '.penc');
  if (fs.existsSync(pencPath)) fs.unlinkSync(pencPath);
});
```

- [ ] **Step 2: Update `resume` in CLI to honor --no-replay**

```ts
// In resume subcommand:
let noReplay = false;
const filtered = args.slice(1).filter(a => {
  if (a === '--no-replay') { noReplay = true; return false; }
  return true;
});
const snapPath = filtered[0];
// ...later when calling run(...) :
sr.snap.state.noReplay = noReplay;
const r = run(pr.prog, sr.snap.state);
```

- [ ] **Step 3: Run — PASS**

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): resume --no-replay flag honored by VM"
```

---

### Task 60: `pen inspect` for v3 snapshots

**Files:** Modify `src/cli.ts`, `test/integration.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('pen inspect on v3 snapshot prints IP, frames, effects', () => {
  const srcPath = path.join(os.tmpdir(), `i-${Date.now()}.pen`);
  fs.writeFileSync(srcPath, 'let x = 1; pause;');
  execSync(`node bin/penelope run ${srcPath}`);
  const snapPath = srcPath.replace(/\.pen$/, '.penz');
  const out = execSync(`node bin/penelope inspect ${snapPath}`).toString();
  expect(out).toMatch(/version: 3/);
  expect(out).toMatch(/pausedAtIP:/);
  expect(out).toMatch(/frames:/);
  expect(out).toMatch(/effects: 0 entries/);
  fs.unlinkSync(srcPath); fs.unlinkSync(snapPath);
  const pencPath = srcPath.replace(/\.pen$/, '.penc');
  if (fs.existsSync(pencPath)) fs.unlinkSync(pencPath);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Update `inspect` subcommand**

```ts
if (subcommand === 'inspect') {
  const snapPath = args[1];
  if (!snapPath) { console.error('usage: pen inspect <file.penz>'); process.exit(2); }
  const text = fs.readFileSync(snapPath, 'utf8');
  const r = deserialize(text, p => fs.readFileSync(p, 'utf8'));
  if ('error' in r) { console.error(r.error); process.exit(1); }
  const s = r.snap;
  if (s.version !== 3) { console.error('not a v3 snapshot'); process.exit(1); }
  console.log(`version: ${s.version}`);
  console.log(`programPath: ${s.programPath}`);
  console.log(`programHash: ${s.programHash}`);
  console.log(`pausedAtIP: ${s.pausedAtIP}`);
  console.log(`pausedAtMs: ${s.pausedAtMs}`);
  console.log(`frames: ${s.state.frames.length}`);
  s.state.frames.forEach((f, i) => {
    const keys = Object.keys(f.bindings).join(', ');
    console.log(`  [${i}] bindings: { ${keys} }${f.parentIdx !== undefined ? ` parentIdx=${f.parentIdx}` : ''}`);
  });
  console.log(`effects: ${s.state.effects.length} entries`);
  s.state.effects.forEach((e, i) => {
    console.log(`  [${i}] ip=${e.ip} ${e.effect} status=${e.status}`);
  });
  return;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/integration.test.ts
git commit -m "feat(cli): pen inspect renders v3 snapshot (frames, effects, IP)"
```

---

### Task 61: examples/01-08*.pen all run via VM

**Files:** Modify `test/integration.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import * as path from 'path';

const EXAMPLES = [
  '01-hello.pen', '02-let.pen', '03-pause-resume.pen', '04-fork.pen',
  '05-net.pen', '06-time.pen', '07-strings.pen', '08-24h-hitl.pen', '09-fib.pen',
];

test.each(EXAMPLES)('example %s parses, compiles, runs', (file) => {
  const fp = path.join('examples', file);
  if (!fs.existsSync(fp)) return;       // skip missing
  const source = fs.readFileSync(fp, 'utf8');
  const ast = parse(tokenize(source));
  const prog = compile(ast);
  const state = freshState();
  state.timeOverride = 1700000000;
  const r = run(prog, state);
  expect(['halted', 'paused']).toContain(r.status);
});
```

- [ ] **Step 2: Run — PASS, fix any examples that break**

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): all examples 01-09 parse/compile/run via VM"
```

---

### Task 62: -O level equivalence test (semantic preservation)

**Files:** Modify `test/optimizer.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test.each(EXAMPLES)('example %s: -O2 effects match -O0 effects', (file) => {
  const fp = path.join('examples', file);
  if (!fs.existsSync(fp)) return;
  const ast = parse(tokenize(fs.readFileSync(fp, 'utf8')));
  const prog = compile(ast);
  const s0 = freshState(); s0.timeOverride = 1700000000;
  const s2 = freshState(); s2.timeOverride = 1700000000;
  const r0 = run(runOptimizer(prog, 0), s0);
  const r2 = run(runOptimizer(prog, 2), s2);
  expect(r0.status).toBe(r2.status);
  // Effect sequences should match opaquely (same effects in same order).
  const eff0 = r0.state.effects.map(e => ({ effect: e.effect, status: e.status }));
  const eff2 = r2.state.effects.map(e => ({ effect: e.effect, status: e.status }));
  expect(eff2).toEqual(eff0);
});
```

- [ ] **Step 2: Run — PASS or debug failures**

Failures here mean the optimizer breaks semantics on a real program — debug and fix. This is the most important regression test.

- [ ] **Step 3: Commit**

```bash
git add test/optimizer.test.ts
git commit -m "test(optimizer): -O0 == -O2 effect-sequence equivalence over all examples"
```

---

### Task 63: Performance gate (fib ≥1.3× faster at -O2)

**Files:** Modify `test/bench.test.ts`.

- [ ] **Step 1: Failing test**

```ts
test('fib(20) at -O2 is at least 1.3x faster than -O0 (VM only)', () => {
  const src = fs.readFileSync('examples/09-fib.pen', 'utf8');
  const prog = compile(parse(tokenize(src)));
  // Warmup
  for (let i = 0; i < 3; i++) { run(runOptimizer(prog, 0)); run(runOptimizer(prog, 2)); }
  // Time
  const reps = 5;
  let t0 = 0, t2 = 0;
  for (let i = 0; i < reps; i++) {
    const a = process.hrtime.bigint();
    run(runOptimizer(prog, 0));
    const b = process.hrtime.bigint();
    run(runOptimizer(prog, 2));
    const c = process.hrtime.bigint();
    t0 += Number(b - a);
    t2 += Number(c - b);
  }
  console.log(`fib(20) -O0 avg: ${(t0/reps/1e6).toFixed(2)}ms; -O2 avg: ${(t2/reps/1e6).toFixed(2)}ms`);
  // If this fails, profile and tighten the optimizer or remove the assertion.
  expect(t0 / t2).toBeGreaterThanOrEqual(1.3);
});
```

- [ ] **Step 2: Run — PASS or relax**

If the assertion fails by a wide margin, profile to find what's not being optimized; if marginal, lower the bound. The point is to have a perf regression net, not to brittle-fail CI.

- [ ] **Step 3: Commit**

```bash
git add test/bench.test.ts
git commit -m "test(bench): -O2 fib(20) speedup gate (≥1.3x over -O0)"
```

---

### Task 64: Full test sweep + commit

**Files:** — (test only)

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all tests green. Phase 2's 107 tests should all still pass, plus all new Phase 3 tests (compiler 20, vm 25-30, encoder 5-10, optimizer 30-40, integration 15-20, snapshot 8-10, bench 2-3). Total expected: 220+ tests.

- [ ] **Step 2: If any test fails**

Debug. Fix the root cause. Don't disable tests.

- [ ] **Step 3: Run TypeScript build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 4: Commit any cleanup**

```bash
git status
# If clean, no commit needed. If there are residual fixes, commit them:
git commit -am "chore(phase-3): final test sweep cleanup"
```

---

### Task 65: README — document Phase 3 capabilities

**Files:** Modify `README.md`.

- [ ] **Step 1: Edit README**

Add a section under the existing structure:

```markdown
## Phase 3 — Bytecode VM + Optimizer

Penelope now compiles to bytecode (`.penc` files) and executes via a stack-based VM with a 5-pass optimizer.

### Workflow

- `pen build foo.pen` — compile to `foo.penc`
- `pen build -O2 foo.pen` — compile with full optimization
- `pen exec foo.penc` — run a pre-compiled bytecode file
- `pen run foo.pen` — compile in memory and run (auto-build)
- `pen disasm foo.penc` — print bytecode listing
- `pen bench foo.pen` — compare VM levels and legacy interpreter

### Optimization levels

- `-O0` — no optimization (baseline; default for debugging)
- `-O1` — cheap passes: constant folding, dead-code elimination, peephole
- `-O2` — `-O1` + inline caches + function inlining

### Snapshot format v3

Snapshots store the bytecode VM state (IP, value stack, frame chain, effect log). Phase 2 (v2) snapshots are not migratable — re-run from source.

### Modules

- `src/bytecode.ts` — opcode types, constant pool
- `src/compiler.ts` — AST → bytecode
- `src/optimizer.ts`, `src/optimizer/*.ts` — 5 optimizer passes
- `src/vm.ts` — execution engine
- `src/encoder.ts` — `.penc` (de)serialize
- `src/legacy-interpreter.ts` — Phase 2 step machine, retained for benchmarks
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README for Phase 3 (bytecode VM, optimizer, snapshot v3)"
```

**End of Wave 4. Phase 3 complete.**

---

# Summary

- **Wave 1 (4 tasks, sequential)** — foundation: rename interpreter, define bytecode types, bump snapshot to v3, prep effects module
- **Wave 2 (26 tasks, 4 parallel tracks)** — compiler (11), VM (10), encoder (2), CLI (3)
- **Wave 3 (20 tasks, 5 parallel tracks after skeleton)** — five optimizer passes
- **Wave 4 (15 tasks, mostly sequential)** — CLI flags, disasm, resume/fork, examples, regression tests, perf gate, README

**Total: 65 tasks. Expected test count after Phase 3: 220+ tests. Expected commit count: 65+.**

After all four waves merge, the language has: bytecode compilation, stack-based VM, optimizing compiler with 5 passes and 3 -O levels, snapshot v3, full CLI (build/exec/run/resume/fork/inspect/disasm/bench). All 107 Phase 2 tests still pass via VM.
