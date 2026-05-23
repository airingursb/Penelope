# Penelope Phase 3 — Design Spec (Bytecode VM + Optimizing Compiler)

**Date**: 2026-05-23
**Status**: Approved, ready for implementation planning
**Scope**: Phase 3 = full C3 (bytecode VM + 5 optimization passes) in one phase. Builds on merged Phase 2 (`1f62b3e`).
**Predecessor**: `docs/superpowers/specs/2026-05-23-penelope-phase-2-design.md`

---

## 1. Goal

Replace Phase 1/2's step-machine interpreter with a **stack-based bytecode VM** preceded by an **optimizing compiler**. The result is a real language runtime: source compiles to `.penc` bytecode files, the VM executes opcodes directly without AST lookup, and an optimizer pass reduces work before execution.

Phase 3 is the foundation for Phase 4 (self-hosting): a stable bytecode + compiler frontend makes "Penelope compiled by Penelope" achievable.

**Acceptance**:
1. All 107 Phase 2 tests pass when run through the new VM (semantics unchanged — every program produces the same output and side effects)
2. ~200 new tests cover compiler, optimizer, VM, .penc encoding, snapshot v3
3. **Performance**: a fib(20) benchmark runs ≥10× faster on the VM than the step machine (the step machine is preserved in `src/legacy-interpreter.ts` purely for this benchmark comparison)
4. `pen build foo.pen → foo.penc; pen exec foo.penc` produces identical output to `pen run foo.pen`
5. `pen disasm foo.penc` pretty-prints the bytecode for debugging
6. All 5 optimizer passes show ≥1 test where the pass demonstrably changes the output bytecode

**Scope size**: ~3× Phase 2 (80-150 tasks, ~200 new tests, 4 new core modules). Single-phase delivery via parallel subagent dispatch where dependencies allow.

---

## 2. Locked Decisions

| # | Decision | Rationale |
|---|---|---|
| V1 | Stack-based VM (not register-based) | Phase 1/2 step machine is already stack-based; minimal cognitive jump; matches WASM/JVM/Python aesthetic |
| V2 | Bytecode stored as JSON arrays of opcode + operand tuples | Aligns with axiom "execution is data"; debuggable; perf cost negligible (we're not chasing nanoseconds) |
| V3 | `.penc` file = JSON program object (program metadata + opcode stream + constant pool) | Self-describing, inspectable with `cat`/`jq` |
| V4 | Compile is explicit (`pen build`) OR implicit (`pen run` auto-builds in-memory) | Explicit for production; implicit for ergonomics |
| V5 | AST is preserved as compiler input only (NEVER executed in Phase 3) | Clean separation: parser owns AST, compiler owns translation, VM owns execution |
| V6 | `src/interpreter.ts` deleted; copy preserved as `src/legacy-interpreter.ts` for benchmark + debugging | Reference impl stays available; no live use |
| V7 | Snapshot version 2 → 3 (breaking change from Phase 2) | VM state shape (IP + frames) is fundamentally different from step machine state (control stack) |
| V8 | Effect log indexed by `(ip, invocationCount)` not `(nodeId, ...)` | The VM doesn't have NodeIds; IP is the stable identity at runtime |
| V9 | Five optimization passes, applied in fixed order | Constant Folding → Dead Code Elim → Inline Caches → Function Inlining → Peephole |
| V10 | `-O0` flag disables all optimization passes (debug + correctness validation) | Same bytecode without/with optimizations must produce same observable output |
| V11 | Frames replace Phase 2's scope dictionary; frame chain is the call stack | Cleaner mental model; one frame = one activation record |
| V12 | Closures capture frame at creation time by reference | Standard lexical closure semantics; closures are JSON-serializable (store frame index, not pointer) |
| V13 | Inline cache stored on the opcode instance (mutates after first execution) | Standard inline cache implementation; cache invalidation on scope tree change |
| V14 | Test framework, ESM, TS strict — all unchanged from Phase 2 | Continuity |
| V15 | Phase 2's 107 tests run via legacy interpreter AND via VM (parametrized) — both must pass | Strong correctness gate: VM output must equal step machine output |

---

## 3. Foundational Axiom (preserved + extended)

> **Execution is data. A running program is a value.**

Phase 3 extension: **the program itself is also data** — bytecode is a serializable value, not just an in-memory representation. `.penc` files are first-class artifacts; you can `cat`, `diff`, `grep` them.

---

## 4. New Architecture

```
   .pen source
      │
      ▼  lexer + parser  (unchanged from Phase 1+2)
   AST
      │
      ▼  compiler.ts  (NEW — replaces "interpreter as executor")
   Bytecode (unoptimized)
      │
      ▼  optimizer.ts  (NEW — 5 passes)
   Bytecode (optimized)
      │
      ▼  encoder.ts  (NEW — JSON serialize)
   .penc file
      │
      ▼  vm.ts  (NEW — execution loop)
   Execution
      │
      ├──► effects.ts  (MODIFIED — IP-based identity)
      └──► snapshot.ts  (MODIFIED — v3 with VMState)
```

Modules:

| Module | Status | Purpose |
|---|---|---|
| `src/ast.ts` | unchanged | AST types |
| `src/lexer.ts` | unchanged | tokenization |
| `src/parser.ts` | unchanged | AST construction |
| `src/interpreter.ts` | **deleted** (moved to legacy-interpreter.ts) | no longer runtime |
| `src/legacy-interpreter.ts` | **moved** | reference for benchmark + future debugging |
| `src/bytecode.ts` | **new** | Opcode type + helpers |
| `src/compiler.ts` | **new** | AST → bytecode (per ASTNode.kind) |
| `src/optimizer.ts` | **new** | 5 passes, each `Bytecode → Bytecode` |
| `src/vm.ts` | **new** | execution loop, opcode dispatch |
| `src/encoder.ts` | **new** | .penc file format |
| `src/effects.ts` | modified | EffectEntry indexed by `ip` |
| `src/snapshot.ts` | modified | version 3, VMState shape |
| `src/cli.ts` | modified | `pen build`/`exec`/`disasm`/`bench` |

---

## 5. Bytecode Design

### 5.1 Program structure

A `.penc` file is JSON of shape:

```ts
type Program = {
  version: 1;                    // bytecode format version (independent from snapshot version)
  source?: string;               // optional pretty source for debug; not needed at runtime
  sourceHash?: string;           // sha256(source) if source path tracked
  constants: ConstantPoolEntry[]; // shared constants referenced by index from opcodes
  code: Opcode[];                // instruction stream
};

type ConstantPoolEntry =
  | { tag: 'int',  v: number }
  | { tag: 'bool', v: boolean }
  | { tag: 'str',  v: string }
  | { tag: 'unit' };
// (closures and effect-name strings are NOT in the constant pool;
//  closures are made at runtime, effect names are inline in EFFECT opcode)
```

The constant pool deduplicates literals across the program (so `print("hello"); print("hello");` shares one str entry).

### 5.2 Opcode set (17 opcodes)

Each opcode is a JSON array `[op_name, ...operands]`. Operands are integers (constant pool indexes, jump offsets, argument counts) or strings (var names, effect names, op tags).

| Opcode | Operands | Stack effect | Semantics |
|---|---|---|---|
| `LOAD_CONST` | `constIdx: int` | → val | push constants[constIdx] onto value stack |
| `LOAD_VAR` | `name: str`, `ic: int?` (inline cache slot, mutable) | → val | resolve `name` via frame chain, push value. After first lookup, cache the `(framesUp, slot)` in `ic`. |
| `STORE_VAR` | `name: str` | val → | pop, bind `name` in current frame's bindings |
| `BIN_OP` | `op: str` | l, r → result | pop right, pop left, apply binop (+, -, *, /, <, <=, >, >=, ==, !=), push result |
| `JUMP` | `target_ip: int` | (no effect) | set IP = target_ip (absolute, not relative) |
| `JUMP_IF_FALSE` | `target_ip: int` | bool → | pop bool; if false, jump to target_ip; else fall through |
| `MAKE_CLOSURE` | `paramNames: str[]`, `body_ip: int`, `body_len: int` | → closure | create closure { paramNames, body_ip, captured_frame_idx: current frame index }; push |
| `CALL` | `argc: int` | closure, arg1, ..., argN → result | pop argc args + closure; push new frame with bindings; jump to body_ip. Return value left on stack after RETURN. |
| `CALL_BUILTIN` | `name: str`, `argc: int` | argN, ..., arg1 → result | call a pure builtin (str_length / str_slice / to_str), push result |
| `RETURN` | | val → | pop val (return value); pop frame; push val onto caller's stack; jump back |
| `EFFECT` | `name: str`, `argc: int`, `ic: int?` | (varies) | route to effects.ts with (current_ip, invocationCount). Replay-aware (Phase 2 logic preserved) |
| `PAUSE` | | → val | yield with current VM state. On resume, value is on stack (Phase 1-2 semantics preserved) |
| `POP` | | val → | discard top |
| `PUSH_UNIT` | | → unit | push unit value |
| `ENTER_BLOCK` | | | new frame (for Block) with empty bindings, parent = current frame |
| `EXIT_BLOCK` | | | pop frame (caller frame becomes current) |
| `HALT` | | | program done; VM main loop exits |

**Closure body layout** in the instruction stream:

When a `Fn` AST node is compiled, the compiler emits:
```
... main code ...
MAKE_CLOSURE paramNames body_ip body_len
JUMP past_body         ← skip over the closure's body (main flow doesn't fall into it)
... body opcodes starting at body_ip ...
RETURN                  ← end of body
past_body: ... continued main code ...
```

This keeps all code in one stream; closure bodies are reached only via CALL.

### 5.3 Inline cache slot

`LOAD_VAR` and `EFFECT` opcodes have an optional `ic` operand that **the VM mutates** on first execution:
- `LOAD_VAR "x" ic` — `ic` starts undefined. First execution does the slow frame-chain walk to find `x` at (framesUp, slot). VM mutates the opcode to `LOAD_VAR "x" {framesUp, slot}`. Subsequent executions read `ic` directly.
- `EFFECT "print" 1 ic` — `ic` caches the count-so-far at this IP across replay, so the lookup is constant-time.

Inline caches are reset when scope structure changes (e.g., resume into a snapshot built with different optimization level — but normal resume keeps caches).

### 5.4 Constant pool deduplication

Identical literals share one entry. Compiler maintains a Map<JSON-stringified-value, index> during compilation.

---

## 6. Compiler Design

### 6.1 Compiler interface

```ts
// src/compiler.ts
export function compile(ast: ASTBundle): Program;
```

Compiler walks AST in post-order, emitting opcodes. Each ASTNode.kind has a deterministic translation. Compiler maintains:
- `constants: ConstantPoolEntry[]` (with dedup map)
- `code: Opcode[]` (the instruction stream being built)
- A scope analyzer for STORE_VAR / LOAD_VAR generation

### 6.2 Per-ASTNode translation (13 kinds)

| ASTNode kind | Emits |
|---|---|
| `IntLit value` | `LOAD_CONST <intern int>` |
| `BoolLit value` | `LOAD_CONST <intern bool>` |
| `StringLit value` | `LOAD_CONST <intern str>` |
| `Var name` | `LOAD_VAR name` |
| `BinOp op left right` | compile(left); compile(right); `BIN_OP op` |
| `Let name value` | compile(value); `STORE_VAR name` |
| `If cond then else` | compile(cond); `JUMP_IF_FALSE A`; compile(then); `JUMP B`; A: compile(else); B: |
| `Fn params body` | `MAKE_CLOSURE params body_ip body_len`; `JUMP past`; body_ip: compile(body); `RETURN`; past: |
| `Call callee args` | If callee is a `Var` naming an effect builtin: compile args, then `EFFECT name argc`. If callee names a pure builtin (str_length/str_slice/to_str): compile args, then `CALL_BUILTIN name argc`. Otherwise (normal closure): compile callee, compile args, `CALL N`. |
| `Pause` | `PAUSE` |
| `ExprStmt expr` | compile(expr); `POP` |
| `Block stmts trailingExpr` | `ENTER_BLOCK`; compile(stmt1); compile(stmt2); ...; if trailingExpr: compile(trailingExpr); else: `PUSH_UNIT`; `EXIT_BLOCK` |
| `Program stmts` | for each stmt: compile(stmt); `HALT` |

(Note: `print` is NOT a separate AST kind — Phase 2 Task 13 removed the `Print` AST node entirely. `print(x)` parses as `Call(Var('print'), [x])` and the compiler's Call case routes it through `EFFECT print 1` via the effect-detection branch above. There are 13 ASTNode kinds total.)

### 6.3 Effect detection at call sites

When compiling `Call(callee, args)`:
- If `callee.kind === 'Var'` AND `EFFECT_NAMES.has(callee.name)` → emit `EFFECT callee.name argc` (after compiling args)
- Else if `callee.kind === 'Var'` AND `PURE_BUILTINS.has(callee.name)` → emit `CALL_BUILTIN callee.name argc`
- Else (normal closure call) → compile callee, then args, then `CALL argc`

---

## 7. VM Design

### 7.1 VMState shape

```ts
export type VMState = {
  ip: number;                       // next instruction to execute
  valueStack: Value[];              // evaluation stack
  frames: Frame[];                  // call stack of frames (top = current)
  effects: EffectEntry[];           // effect log (Phase 2 carry-over, indexed by ip)
  timeOverride?: number | null;     // for now() determinism in test
  noReplay?: boolean;               // CLI flag
};

export type Frame = {
  bindings: Record<string, Value>;  // local + captured names
  returnIP?: number;                // for CALL; undefined for top-level/block frames
  parentIdx?: number;               // frame chain via index (NOT pointer) for serialization
};
```

Frames have a `parentIdx` so the chain is serializable (no closures, no pointers).

### 7.2 Execution loop

```ts
export function run(program: Program, initialState: VMState): RunResult;

type RunResult =
  | { kind: 'done',   finalValue: Value | null }
  | { kind: 'paused', state: VMState, pausedAtIP: number }
  | { kind: 'error',  message: string, ip?: number };

// Inside run():
while (true) {
  if (state.ip >= program.code.length) {
    return { kind: 'done', finalValue: state.valueStack[-1] ?? null };
  }
  const op = program.code[state.ip];
  // dispatch on op[0]:
  switch (op[0]) {
    case 'LOAD_CONST': { ... state.ip++ }
    case 'JUMP': { state.ip = op[1] }
    case 'CALL': { push new frame; state.ip = closure.body_ip }
    case 'PAUSE': { state.ip++; return { kind: 'paused', state, pausedAtIP: state.ip - 1 } }
    case 'HALT': { return { kind: 'done', finalValue: ... } }
    ...
  }
}
```

### 7.3 Effect routing

`EFFECT name argc` looks identical to Phase 2 conceptually:
- Pop argc args from value stack
- Compute invocationCount from `state.effects.filter(e => e.ip === state.ip).length`
- Look up existing entry at `(ip, invocationCount)`
- Branch: replay (committed) / re-pause (pending wait) / first execution

All effect-handler code from Phase 2 (`performNetFetch`, `performNow`, etc.) is reused. Only the identity key changes from `nodeId` to `ip`.

### 7.4 Pause semantics

`PAUSE` opcode: increment IP, return `{ kind: 'paused', state, pausedAtIP: ip }`. On resume, VM continues from the incremented IP — same pattern as Phase 1/2.

---

## 8. Optimizer Design (5 passes)

Each pass is `Bytecode → Bytecode` over the `Program.code` array. Passes are pure functions. Order matters; passes run in this sequence.

### 8.1 Pass 1 — Constant Folding

Scan for `LOAD_CONST a, LOAD_CONST b, BIN_OP op` triples where the binop is fold-safe (no division by zero, no type mismatch). Replace with `LOAD_CONST <result>`.

Example:
```
LOAD_CONST 1   LOAD_CONST 2   BIN_OP +
                    ↓
LOAD_CONST 3
```

Recursive: after one fold, the previous opcode might form another fold candidate. Iterate to fixpoint.

### 8.2 Pass 2 — Dead Code Elimination

Two sub-cases:
- **Dead branch**: `LOAD_CONST <bool literal>, JUMP_IF_FALSE target_ip, ...` where the bool is known at compile time → eliminate either the then-block (if true) or the else-block (if false) entirely
- **Unreachable code**: after `HALT` or `RETURN`, all subsequent opcodes until the next JUMP target are unreachable → remove

Iterate after Constant Folding (constant folding makes more bool literals visible).

### 8.3 Pass 3 — Inline Caches

Walk the program; for every `LOAD_VAR name`, replace with `LOAD_VAR name <empty ic slot>`. Similarly for `EFFECT`. The VM will fill these slots at first execution.

This pass doesn't change semantics; it just adds slots for runtime caching.

### 8.4 Pass 4 — Function Inlining

For each `CALL argc` opcode where:
- The callee is statically known (it was pushed by an immediately-preceding `LOAD_VAR name` where `name` was assigned a `MAKE_CLOSURE` literal in the same function)
- The closure's body is < 20 opcodes
- The closure has no `PAUSE` or `EFFECT` (avoid moving side-effect points across inlining)

→ replace the call site with the inlined body, substituting param names → arg values.

This is the most complex pass. Phase 3 ships a simplified version: inline ONLY when the closure is a `let name = fn(...)` immediately preceding the call.

### 8.5 Pass 5 — Peephole

A small window (3-5 opcode lookbehind) scanner that removes:
- `LOAD_CONST x, POP` → (nothing)
- `STORE_VAR x, LOAD_VAR x` → `STORE_VAR x` plus push duplicate (or use a dedicated `DUP` opcode — but we don't have one; skip this rewrite)
- `JUMP target_ip` where `target_ip` points immediately to the next opcode → remove the JUMP
- `JUMP a; ... a: JUMP b` → `JUMP b; ...` (jump threading)

### 8.6 -O0 flag

`pen build -O0 foo.pen` skips all 5 passes. Bytecode emitted directly from compiler.

`-O1` (default) runs Constant Folding + Inline Caches + Peephole.
`-O2` runs all 5.

Semantic invariant: **for any program P, running -O0, -O1, -O2 bytecode through the VM produces identical observable output**. Tests enforce this for every example.

---

## 9. .penc Encoding

JSON. Pretty-printed (2-space indent) by default; `--minify` flag emits dense JSON.

`.penc` file structure:

```json
{
  "version": 1,
  "source": "let x = 10; print(x);",
  "sourceHash": "sha256:abc...",
  "constants": [
    { "tag": "int", "v": 10 }
  ],
  "code": [
    ["LOAD_CONST", 0],
    ["STORE_VAR", "x"],
    ["LOAD_VAR", "x", null],
    ["EFFECT", "print", 1, null],
    ["POP"],
    ["HALT"]
  ]
}
```

`encoder.ts` exports `serialize(program): string` and `deserialize(json): Program | { error }`.

---

## 10. Snapshot v3

```ts
type Snapshot = {
  version: 3;
  programPath: string;     // .penc file path
  programHash: string;     // sha256(.penc content)
  pausedAtIP: number;      // VM IP at pause
  pausedAtMs: number;
  state: VMState;          // see §7.1
};
```

`deserialize` rejects v1 and v2 with helpful error messages.

---

## 11. CLI Extensions

```bash
pen build foo.pen [--out foo.penc] [-O0 | -O1 | -O2] [--minify]
pen exec foo.penc [<resume-args>...]
pen run foo.pen [...]              # auto-build to temp, then exec
pen resume foo.penz [...]          # unchanged interface; loads .penc via programPath
pen disasm foo.penc                # pretty-print opcodes
pen bench foo.pen                  # run + report time + opcode count
pen inspect foo.penz               # updated to show VMState (IP, frames, effects)
```

`pen run` after Phase 3:
1. Parse source
2. Compile (with default -O1)
3. Write temp .penc to `<source>.penc` next to source (cacheable)
4. Exec the .penc

`pen exec foo.penc`:
1. Read .penc
2. Run via VM

If `<source>.penc` exists AND its sourceHash matches the .pen file's hash, `pen run` skips compilation.

---

## 12. Effect System Migration

`EffectEntry`:

```ts
type EffectEntry = {
  ip: number;             // CHANGED from nodeId
  invocationCount: number;
  effect: EffectName;
  recordedValue: Value | null;
  status: 'pending' | 'committed';
};
```

All Phase 2 effect logic preserved: write=skip, read=replay, wait=re-pause-or-commit. Only the identity key changes.

`pen inspect` shows `@ip 42 #0 print value=()` instead of `@n7 #0 print value=()`.

---

## 13. Acceptance Test Catalog (~200 tests across 13 groups)

### Group A — Bytecode types + helpers (5 tests, test/bytecode.test.ts)
- A1-A5: Opcode array shape; constant pool dedup; encoding utilities

### Group B — Compiler per-ASTNode (20 tests, test/compiler.test.ts)
- One test per ASTNode kind (13) + 7 edge cases (nested fn, deep block, multi-stmt program)
- Each test: `compile(parse(tokenize(SRC)))` produces expected `code: Opcode[]`

### Group C — VM per-opcode (17 tests, test/vm.test.ts)
- One test per opcode (17 in §5.2) covering both success path and basic edge case.

### Group D — VM running real programs (20 tests, test/vm.test.ts)
- Each Phase 1/2 program (arithmetic, let, if, fn, closure, print) re-runs through VM and gets same output

### Group E — Optimizer pass 1: Constant Folding (10 tests)
- E1: `1+2` folds to `3`
- E2: `(1+2)*3` folds to `9`
- E3: `1/0` does NOT fold (would error at compile; preserve as runtime error)
- E4-E10: assorted cases incl. negative folds, comparison folds, equality folds, mixed type → no fold

### Group F — Optimizer pass 2: Dead Code Elimination (8 tests)
- F1: `if (true) {A} else {B}` → A only
- F2: `if (false) {A} else {B}` → B only
- F3: Code after HALT removed
- F4-F8: nested branches, multi-stmt programs, dead fn bodies

### Group G — Optimizer pass 3: Inline Caches (5 tests)
- G1: `LOAD_VAR x` after pass has IC slot
- G2: First execution fills the IC; second hits cache
- G3-G5: scope invalidation, nested closures, effect ICs

### Group H — Optimizer pass 4: Function Inlining (8 tests)
- H1: small fn call inlined
- H2: fn with PAUSE NOT inlined
- H3: fn with EFFECT NOT inlined
- H4-H8: param substitution, multi-call, recursive (NOT inlined)

### Group I — Optimizer pass 5: Peephole (8 tests)
- I1: `LOAD_CONST, POP` removed
- I2: `JUMP next` removed
- I3-I8: jump threading, etc.

### Group J — -O0/-O1/-O2 equivalence (5 tests)
- For each of 5 sample programs: output is identical at all 3 optimization levels

### Group K — .penc encoding (8 tests)
- K1: serialize/deserialize roundtrip
- K2: minify produces parseable output
- K3: version mismatch rejection
- K4-K8: source hash validation, missing source ok, etc.

### Group L — Snapshot v3 (8 tests)
- L1: VMState shape roundtrip
- L2: v2 snapshots rejected (with helpful message)
- L3-L8: pause + resume across processes via VM

### Group M — CLI integration (15 tests)
- M1: `pen build` produces .penc
- M2: `pen exec` runs .penc
- M3: `pen run` auto-builds + execs
- M4: `pen disasm` pretty-prints
- M5: `pen bench` reports time and opcode count
- M6: `-O0 / -O1 / -O2` flags propagate
- M7-M15: smoke tests for various effect scenarios via VM

### Group N — Phase 2 regression (parametrized over 107 existing tests)
- All Phase 2 unit tests run; for those that previously asserted via interpreter, re-route through VM path
- All Phase 2 integration tests pass with the new run/exec wiring

### Group O — Benchmark (3 tests)
- O1: fib(20) via VM ≥10× faster than via legacy interpreter
- O2: opcode count for fib(20) matches expected (regression detection)
- O3: -O2 produces fewer opcodes than -O0 for fib(20)

Total: **~135 new tests + 107 preserved = ~242 tests** when Phase 3 ships.

---

## 14. File Layout Diff

```
src/
  ast.ts                  unchanged
  lexer.ts                unchanged
  parser.ts               unchanged
  interpreter.ts          DELETED
  legacy-interpreter.ts   NEW (copied from old interpreter.ts; only used by bench)
  bytecode.ts             NEW
  compiler.ts             NEW
  optimizer.ts            NEW
  vm.ts                   NEW
  encoder.ts              NEW
  effects.ts              MODIFIED (EffectEntry.ip)
  snapshot.ts             MODIFIED (v3, VMState)
  cli.ts                  MODIFIED (build/exec/disasm/bench)
test/
  bytecode.test.ts        NEW
  compiler.test.ts        NEW
  vm.test.ts              NEW
  optimizer.test.ts       NEW
  encoder.test.ts         NEW
  bench.test.ts           NEW
  integration.test.ts     MODIFIED (Phase 3 acceptance through VM)
  (all existing test files): MODIFIED to use VM where they used interpreter
examples/
  09-fib.pen              NEW (benchmark target)
  (existing 01-08): unchanged
```

---

## 15. Implementation Order — Parallel Subagent Strategy

Phase 3 has natural parallelism. Dispatch in **waves**, with subagents working in parallel within a wave.

**Wave 1 (sequential foundation, ~5 tasks)**:
- W1.0: Move `interpreter.ts` → `legacy-interpreter.ts` (keep import-name)
- W1.1: `bytecode.ts` — Opcode type definitions, constant pool helpers
- W1.2: Snapshot v3 bump (reject v2, add VMState type — without impl yet)
- W1.3: effects.ts EffectEntry → ip (compile error gate — until vm.ts exists, this fails build; mark TODOs)

**Wave 2 (parallel — 4 modules independently, ~50 tasks)**:
- W2.A: `compiler.ts` (13 ASTNode cases + effect/builtin detection) — ~20 tasks
- W2.B: `vm.ts` (17 opcode dispatch + run loop + frame mgmt) — ~22 tasks
- W2.C: `encoder.ts` (.penc serialize/deserialize) — ~5 tasks
- W2.D: cli.ts `pen build/exec` subcommands — ~5 tasks (depends on W2.A+B+C completion)

**Wave 3 (parallel — 5 optimizer passes, ~25 tasks)**:
- W3.A: Constant Folding
- W3.B: Dead Code Elimination
- W3.C: Inline Caches
- W3.D: Function Inlining
- W3.E: Peephole

Each pass is a self-contained file/function. Implementer subagent can work in parallel.

**Wave 4 (sequential integration, ~20 tasks)**:
- W4.1: All 107 Phase 2 tests re-run via VM (port test setup)
- W4.2: `pen disasm` subcommand
- W4.3: `pen bench` subcommand
- W4.4: 09-fib.pen + benchmark integration test (Group O)
- W4.5: `-O0/-O1/-O2` flag wiring
- W4.6: `pen inspect` updated for VMState
- W4.7: All Phase 2 examples re-run via VM
- W4.8: README Phase 3 status

Total: ~100 tasks across 4 waves. With parallelism in Waves 2-3, wall-clock time ≈ 60 tasks-equivalent.

---

## 16. Out of Scope (Phase 3, explicit)

- Live editing (pause → edit source → resume) — Phase 4 candidate
- Time-travel debugger UI — separate phase
- Distributed snapshot migration — separate phase
- JIT compilation (bytecode → native) — never (Penelope is a learning project)
- Garbage collection of unreachable closures — rely on JS GC
- Bytecode versioning migration — v1 only; if format changes later, rebuild
- Tail call optimization
- Exception/error effects beyond Phase 2's `{kind:'error'}` returns
- HTTP methods beyond GET, string interpolation, modules — Phase 2 deferrals carry forward

---

## 17. Phase 4 Forward-Compatibility Notes

- The compiler + optimizer + VM forms the architectural basis for self-hosting (Penelope written in Penelope produces .penc files that this VM can run)
- `EffectEntry.ip` is a stable identity — if Phase 4 introduces source-level tooling, the IP→source mapping is added as a side-table (sourcemap-equivalent)
- The constant pool format is extensible: future tags (e.g., `bytes`, `bigint`) added without breaking existing .penc files (consumer pattern-matches known tags, errors on unknown)
- Snapshot v3 is the format Phase 4 will likely keep (no obvious reason to bump)

---

## 18. Phase 3 Done Criteria

1. `npm test` exits 0 — all ~242 tests pass
2. `pen build examples/01-toplevel-pause.pen && pen exec examples/01-toplevel-pause.penc` produces same output as `pen run examples/01-toplevel-pause.pen`
3. Phase 2 demo `pen run examples/08-24h-agent.pen` followed by the two resumes works identically through the VM (with the same /tmp/penelope-audit.log content)
4. fib(20) benchmark shows ≥10× speedup VM vs legacy interpreter
5. Conventional Commits throughout
6. Branch `feat/phase-3` merged to `main`
