# Penelope Phase 2 — Design Spec (Effect System / Agent Runtime)

**Date**: 2026-05-23
**Status**: Approved, ready for implementation planning
**Scope**: Phase 2 only. Builds on the merged Phase 1 (`63bd925`). References Phase 3+ where decisions are forward-looking.
**Predecessor**: `docs/superpowers/specs/2026-05-22-penelope-phase-1-design.md`

---

## 1. Goal

Make pause/resume **correct under impure code**. Penelope becomes a real agent runtime: programs can call the network, the filesystem, the clock, the RNG, and wait for external events — and *all of it survives pause/resume/fork without re-firing*.

**Acceptance demo:** a 24-hour HITL approval agent that
1. `print`s a request,
2. `wait_for("approval")`s a human decision (could be days),
3. `net_fetch`es an LLM response based on the decision,
4. `print`s the result,
5. `write_file`s an audit log entry.

The demo **crashes twice mid-flight** (between steps 1-2 and between steps 3-4). After two `pen resume`s, the agent completes correctly: every print appears exactly once, every write_file fires exactly once, the LLM call returns the originally-fetched response, and the audit log has exactly one entry.

**Scope size**: ~2× Phase 1 (8 effect primitives + strings + snapshot v2 + CLI flags + ~38 tests).

---

## 2. Locked Decisions Summary

| # | Decision | Rationale |
|---|---|---|
| E1 | Add 8 effect primitives (see §6) | "Real-world agent runtime" demands network, FS, time, random, events |
| E2 | Effect identity = `(nodeId, invocationCount)` | Same call site in a loop can fire multiple times — counter disambiguates |
| E3 | Effect log lives at snapshot top level (not sidecar) | Snapshot stays self-contained; fork naturally copies log |
| E4 | Snapshot version: 1 → 2 (no Phase-1 backwards compat) | Breaking change; effect log changes the contract |
| E5 | Effect API: reserved underscore-named builtin functions | `net_fetch(url)`, `wait_for(name)` — no `.` syntax, no new module system |
| E6 | Three replay categories: **write**=skip, **read**=replay, **wait**=re-pause-or-continue | Standard durable-execution categorization |
| E7 | Add `string` value type | Necessary for url/path/event-name parameters |
| E8 | String surface: literals + `+` concat + `==`/`!=` + `str_length` + `str_slice` | Minimal; **no interpolation** in Phase 2 |
| E9 | External event delivery: `pen resume --event NAME=VALUE` | Sequential, file-based; no daemon |
| E10 | Effect handlers live in `src/effects.ts` (new module) | Single responsibility — separate from interpreter pure core |
| E11 | `print` is the only Phase-1 carry-over to gain replay semantics | Pre-existing op, now also logged |
| E12 | `--no-replay` flag overrides skip-on-replay | Debugging escape hatch |
| E13 | `--time MS` flag overrides `now()` | Deterministic testing |
| E14 | Test framework, ESM, TS strict, etc. — unchanged from Phase 1 | Continuity |

---

## 3. Foundational Axiom (unchanged)

> **Execution is data. A running program is a value.**

Phase 2 extends the axiom: **side effects ARE data too** — every effect call appends a JSON-serializable entry to a log. Replay reads from the log instead of re-firing.

---

## 4. Language Surface — Diff from Phase 1

### 4.1 New value type
```ts
type Value =
  | { tag: 'int',     v: number }
  | { tag: 'bool',    v: boolean }
  | { tag: 'closure', paramNames, bodyBlockId, capturedScopeId }
  | { tag: 'unit' }
  | { tag: 'str',     v: string };   // ← NEW
```

### 4.2 New AST node
```ts
| { id: NodeId; kind: 'StringLit'; value: string }
```

### 4.3 New lexer token
`STRING` — scanned by `"` open, `"` close, `\n` / `\\` / `\"` escapes. (`$` is NOT recognized as interpolation.)

### 4.4 Operator overloading
- `+` works on string×string → string (else int×int → int as before)
- `==` / `!=` work on string×string (else as before)
- Type mismatch → runtime error: `cannot apply '+' to int and str`

### 4.5 New builtin functions (effect primitives)

All are reserved identifiers — they look like normal function calls but the interpreter recognizes them specially:

```pen
print(any) → unit                  // existing, now also logged
str_length(s: str) → int           // pure, no log
str_slice(s: str, lo: int, hi: int) → str  // pure, [lo, hi) exclusive, Python-style
to_str(any) → str                  // pure conversion: int → "42", bool → "true"/"false",
                                   // unit → "()", str → identity, closure → "<fn>"
                                   // needed so user code can do print("amount: " + to_str(n))

net_fetch(url: str) → str          // HTTP GET, returns body
now() → int                        // Unix ms
random_int(lo: int, hi: int) → int // uniform random [lo, hi]
read_file(path: str) → str         // file content
write_file(path: str, body: str) → unit
wait_until(ms: int) → unit         // pause until ms have elapsed (wall clock)
wait_for(name: str) → any          // pause until external event with name arrives
```

A `Call` whose callee is a `Var` with one of these names triggers the effect path in `step()`. Any other Call uses Phase 1's closure-invoke path. Users **cannot define functions with these names** (parse-time error if they `let` an identifier with a reserved name).

### 4.6 Removed from Phase 1 "out of scope" list (now in)
- String literals
- String concat (via `+` overload)

### 4.7 Still out of scope (Phase 2)
- String interpolation (`"hello $name"`)
- String methods other than `str_length` / `str_slice`
- Effect type signatures (`fn foo() :: Net`) — Phase 3
- User-defined effects — Phase 3
- Effect handlers / resumption-style continuations — Phase 3
- HTTP methods other than GET
- File listing, file delete, file stat
- Modules, network errors with retry, secrets, crypto

---

## 5. Architecture — Diff from Phase 1

```
                        cli.ts
                          │
   ┌──────────────────────┼──────────────────────┐
   ▼                      ▼                      ▼
lexer.ts             parser.ts              interpreter.ts ──► snapshot.ts
   │                      │                      │   ▲              │
   └──────────────────────┴────────► ast.ts ◄───┘   │              │
                                                     │              │
                                              effects.ts ◄──────────┘
                                              (NEW)
```

**One new module: `effects.ts`**. It owns the side-effect implementations (`performNetFetch`, `performWriteFile`, etc.) and the effect log helpers. `interpreter.ts` calls into it for the first-execution path of each effect; on replay, `interpreter.ts` reads the log itself without calling `effects.ts`.

**Single-responsibility**: `interpreter.ts` stays pure-ish (only `console.log` for the legacy `print`, which now also goes through `effects.ts`). All real IO is in `effects.ts`.

---

## 6. Effect System Core

### 6.1 The Effect Log

Appended to `Snapshot` and `State`:

```ts
type EffectEntry = {
  nodeId: NodeId;            // the Call site's AST node id
  invocationCount: number;   // 0-based count of how many times this nodeId has fired
  effect: EffectName;        // 'print' | 'net_fetch' | 'now' | 'random_int' |
                             // 'read_file' | 'write_file' | 'wait_until' | 'wait_for'
  recordedValue: Value | null; // for read effects: the returned value
                             // for write effects: null
                             // for wait_for PENDING: { tag: 'str', v: <event-name> } so CLI can match --event NAME=VALUE
                             // for wait_for COMMITTED: the event value supplied at resume (overwrites the name)
                             // for wait_until PENDING and COMMITTED: { tag: 'int', v: targetMs } (the target wall-clock time)
  status: 'pending' | 'committed';
                             // wait_for/wait_until start 'pending' (paused);
                             // 'committed' once the value is supplied / time elapsed.
                             // read/write effects are 'committed' immediately.
};

type State = {
  // ... Phase 1 fields unchanged ...
  effects: EffectEntry[];    // ← NEW: append-only log
};

type Snapshot = {
  version: 2;                // ← bumped from 1
  // ... Phase 1 fields unchanged ...
  state: State;              // (which now carries `effects`)
};
```

`EffectName` is a string-literal union of the 8 names listed in §4.5 (minus `print`, `str_length`, `str_slice` — those are different; see below). Actually 8 effectful ones:
- `print` is effectful (write)
- `str_length` / `str_slice` are **pure** — they don't enter the log

So **EffectName = 8 names**:
`'print' | 'net_fetch' | 'now' | 'random_int' | 'read_file' | 'write_file' | 'wait_until' | 'wait_for'`.

### 6.2 Invocation Count

When the interpreter encounters a `Call` to an effect builtin:
1. Look at all existing `EffectEntry` entries with this `nodeId`. Count them: `c = entries.filter(e => e.nodeId === thisNodeId).length`.
2. The new entry's `invocationCount` is `c`.
3. On replay, lookup uses `(nodeId, invocationCount=c)` to find the matching entry.

This means a single AST call site inside a loop produces multiple entries, distinguished by sequential count.

### 6.3 Replay Algorithm

```
On stepping a Call node N whose callee is an effect builtin:
  Let count = number of existing effects entries with nodeId === N
  Let existing = state.effects.find(e => e.nodeId === N && e.invocationCount === count)

  IF existing is found (replay path):
    SWITCH on existing.effect category:
      'write' (print, write_file):
          SKIP the actual IO. Push unit onto valueStack. Done.
      'read' (net_fetch, now, random_int, read_file):
          Push existing.recordedValue onto valueStack. Done.
      'wait' (wait_until, wait_for):
          IF existing.status === 'committed':
              Push existing.recordedValue onto valueStack. Done.
          ELSE (still pending):
              Treat as a fresh pause. Return { kind: 'paused', pausedAt: N }.
              (The snapshot already has the entry as pending; nothing to add.)

  ELSE (first execution path):
    SWITCH on the builtin name:
      'write' kind:
          Perform the IO via effects.ts. Append entry { ..., status: 'committed', recordedValue: null }.
          Push unit. Done.
      'read' kind:
          Perform the IO via effects.ts to get value v.
          Append entry { ..., status: 'committed', recordedValue: v }.
          Push v. Done.
      'wait_until':
          Compute targetMs = now() + ms. Append entry { ..., status: 'pending', recordedValue: { tag: 'int', v: targetMs } }.
          Return { kind: 'paused', pausedAt: N }.
      'wait_for':
          Append entry { ..., status: 'pending', recordedValue: null }.
          Return { kind: 'paused', pausedAt: N }.

On resume:
  CLI parses --event NAME=VALUE flags and --time MS.
  For each --event NAME=VALUE:
    Find the topmost 'pending' wait_for entry where (lookup-time) name === NAME.
    Set entry.status = 'committed' and entry.recordedValue = parsed VALUE.
  For wait_until entries that are still pending:
    Get current wall-clock time (or --time override).
    If currentMs >= entry.recordedValue.v, mark as committed (recordedValue stays the targetMs).
    Else, leave pending — the program will pause again immediately when re-stepped.

  Then proceed with the normal step loop. The effect-replay path will pick up committed entries.
```

### 6.4 Effects.ts module API

```ts
// src/effects.ts

export type EffectName =
  | 'print' | 'net_fetch' | 'now' | 'random_int'
  | 'read_file' | 'write_file' | 'wait_until' | 'wait_for';

export const EFFECT_NAMES: ReadonlySet<EffectName> = new Set([...]);

export type EffectCategory = 'write' | 'read' | 'wait';

export function categoryOf(name: EffectName): EffectCategory { ... }

// First-execution side-effect performers.
// These are the ONLY places real IO happens (plus console.log for print).
export function performPrint(arg: Value): void;
export function performWriteFile(path: string, body: string): void;
export function performNetFetch(url: string): Promise<string>;  // BUT see §6.5
export function performNow(): number;
export function performRandomInt(lo: number, hi: number): number;
export function performReadFile(path: string): string;
```

### 6.5 Sync vs Async I/O (important)

**Problem**: `net_fetch` is naturally async (HTTP). But the step machine is synchronous (Phase 1 is `step(state) → result`).

**Solution for Phase 2**: keep step synchronous. `performNetFetch` uses `child_process.spawnSync('curl', ['-sS', url])` or Node's experimental sync fetch (Node 18+ `fetch()` is async). **Phase 2 will use a sync HTTP via spawning `curl`** to keep `step()` synchronous. This is a deliberate compromise:
- ✅ Keeps the interpreter shape
- ✅ No async/await throughout the codebase
- ❌ Requires `curl` to be installed
- ❌ Per-request fork overhead (acceptable for Phase 2 demo scale)

`read_file` / `write_file` use sync `fs.readFileSync` / `fs.writeFileSync` — no problem.

Phase 3 will introduce async at the runtime layer with proper handler-driven semantics.

### 6.6 Reserved builtin name guard

Parser (or, easier, interpreter) rejects:
```pen
let net_fetch = fn() { ... };   // ERROR: 'net_fetch' is a reserved builtin
fn write_file() { ... };        // ERROR: same
```

Implementation: in `interpreter.ts` `Let` case, if `name` is in `EFFECT_NAMES` ∪ `{'str_length', 'str_slice'}`, return runtime error. (Parse-time check would be cleaner but requires more parser change.)

---

## 7. The 8 Effects — Per-Effect Spec

### 7.1 `print(any) → unit`
- Category: **write**
- Already exists in Phase 1; Phase 2 adds an entry to the effect log on first execution. Replay skips. `print` accepts any Value type (formatValue handles all).
- Format: `formatValue` for str case returns the raw string content (no quotes).

### 7.2 `net_fetch(url: str) → str`
- Category: **read**
- Sync HTTP GET via `spawnSync('curl', ['-sS', '--fail', '-A', 'Penelope/0.2', url])`.
- On non-zero exit: runtime error `net_fetch failed: <stderr>`.
- Returns the response body as a string. Headers are discarded.

### 7.3 `now() → int`
- Category: **read**
- `Date.now()`. Returns Unix milliseconds.
- `--time MS` CLI flag overrides for testing.

### 7.4 `random_int(lo: int, hi: int) → int`
- Category: **read**
- `Math.floor(Math.random() * (hi - lo + 1)) + lo` — uniform integer in `[lo, hi]`.
- No seed in Phase 2 (replay just uses the recorded value). Phase 3 will add seed.

### 7.5 `read_file(path: str) → str`
- Category: **read**
- `fs.readFileSync(path, 'utf8')`.
- ENOENT or read error → runtime error `read_file failed: <message>`.

### 7.6 `write_file(path: str, body: str) → unit`
- Category: **write**
- `fs.writeFileSync(path, body, 'utf8')`.
- Overwrites existing. No append mode in Phase 2.
- Error → runtime error.

### 7.7 `wait_until(ms: int) → unit`
- Category: **wait**
- First call: compute `targetMs = now() + ms`, append `{ status: 'pending', recordedValue: IntVal(targetMs) }`, pause.
- Resume: if current time (or `--time`) ≥ `targetMs`, mark committed and continue (returns unit). Else stays pending — re-pauses immediately.

### 7.8 `wait_for(name: str) → any`
- Category: **wait**
- First call: append `{ status: 'pending', recordedValue: null }`, pause.
- Resume with `--event NAME=VALUE`: parse VALUE per the same rules as the Phase 1 resume positional arg (int / bool / **and now also str: `name=hello`** where any text after = is treated as a string if not numeric/boolean).
- Returns the parsed value as the result of the `wait_for(...)` expression.

---

## 8. CLI Extensions

### 8.1 `pen resume` updated signature

```bash
pen resume <snap.penz> [<value>]                    # Phase 1 compat: positional for pause()
pen resume <snap.penz> --event approval=true        # inject one event
pen resume <snap.penz> --event a=1 --event b=hello  # multiple events
pen resume <snap.penz> --time 1234567890            # mock now() / wait_until ref time
pen resume <snap.penz> --no-replay                  # re-execute effects (don't use log)
```

`<value>` and `--event ...` can coexist (positional for `pause`, events for `wait_for`s).

### 8.2 `pen inspect` updated

Add a new section after Control stack:
```
Effect log (N entries):
  1. [committed] print          n12  <unit>
  2. [committed] net_fetch      n25  "OK\n..."
  3. [pending]   wait_for       n31  (name='approval')
```

### 8.3 Exit codes (unchanged from Phase 1)

---

## 9. Snapshot Format v2

```ts
type Snapshot = {
  version: 2;                         // bumped
  programPath: string;
  programHash: string;
  pausedAt: NodeId;
  pausedAtMs: number;
  state: State;                       // State now carries effects: EffectEntry[]
};
```

### 9.1 Migration / compatibility
- `deserialize` rejects v1 snapshots with `unknown snapshot version: 1. Use Phase 1 binary to resume.`
- Future: `pen migrate <v1.penz>` could lift v1 → v2 (just adds `effects: []`). Not in Phase 2.

---

## 10. Testing Strategy

- **Unit tests** continue per-module:
  - `test/string.test.ts` — string lexer, parser, interpreter eval
  - `test/effect.test.ts` — effect log infrastructure, every effect's record/replay
  - existing unit tests adjusted only as needed (most should still pass)
- **Integration tests**:
  - Existing 3 demos from Phase 1 should still pass (no regression)
  - 5 new demos (see §11) covering the new effects
  - **THE Phase 2 demo**: 24h HITL agent with 2 crashes
- `vitest run` exits 0 — same Phase 1 success criterion

---

## 11. Acceptance Test Catalog

The plan will implement each of these as a dedicated test. Listed here so the plan can be 1-to-1 task-mapped.

### Group A — Strings (10 tests, `test/string.test.ts`)
| # | Name | Source | Assertion |
|---|---|---|---|
| A1 | string literal parses to StringLit | `"hello";` | AST has `StringLit value: 'hello'` |
| A2 | string literal evaluates | `"hello";` | finalValue = `{ tag: 'str', v: 'hello' }` |
| A3 | string + string concat | `"abc" + "def";` | result = `{ tag: 'str', v: 'abcdef' }` |
| A4 | string equality | `"a" == "a";` | true; `"a" == "b"` → false |
| A5 | str_length | `str_length("hello");` | result = `IntVal(5)` |
| A6 | str_slice basic | `str_slice("hello", 1, 4);` | result = `StrVal("ell")` |
| A7 | str_slice edge: empty, full, OOB | various | empty/full/clip |
| A8 | escape sequences | `"a\nb"`, `"a\\b"`, `"a\"b"` | correctly parsed |
| A9 | print on string | `print("hello");` | stdout `hello` (no quotes) |
| A10 | int + str type mismatch | `1 + "a";` | runtime error containing 'cannot apply' |
| A11 | to_str on each Value tag | `print(to_str(42)); print(to_str(true)); print(to_str(false));` | stdout = `42\ntrue\nfalse` |
| A12 | to_str + concat in real use | `print("amount: " + to_str(5000));` | stdout = `amount: 5000` |

### Group B — Effect log infrastructure (5, `test/effect.test.ts`)
| # | Name | Setup | Assertion |
|---|---|---|---|
| B1 | print appends one effect entry | run `print(1);` to completion | state.effects has 1 entry with effect='print' |
| B2 | invocationCount increments per call | run `print(1); print(2);` | two entries with same nodeId? actually different nodeIds; verify both committed |
| B3 | nodeId + count keys are unique | loop `let i = 0; ... print(i)` — can't loop in Phase 2 surface; use multi-call | multiple entries with sequential counts |
| B4 | snapshot serialize/deserialize preserves effects | manually craft + roundtrip | deep equal |
| B5 | inspect prints effect log | `pen inspect` output | contains `Effect log` section |

### Group C — print replay safety (3)
| # | Name | Flow | Assertion |
|---|---|---|---|
| C1 | print before pause not re-printed on resume | `print("hi"); let x = pause; print(x);` → resume 5 | stdout on resume = `5` only (no `hi`) |
| C2 | print after resume runs fresh | same as C1 | second print's nodeId+count NOT in log on resume; gets logged |
| C3 | print on fork branches each log own entries | `print("base"); let x = pause; print(x);` → fork 1 2 | each fork branch's resume doesn't re-print `base`; both print their own x value |

### Group D — net_fetch (3)
| # | Name | Flow | Assertion |
|---|---|---|---|
| D1 | net_fetch records URL+body on first call | `let r = net_fetch("https://httpbin.org/uuid"); print(r);` → run, pause not hit (uses curl?) actually program ends; check effect log post-completion via separate test rig | log has one net_fetch entry with recordedValue.v == response body |
| D2 | net_fetch on replay returns logged body | program: `let r = net_fetch("..."); let x = pause; print(r);` → resume | network NOT called; print outputs original body |
| D3 | second call site to net_fetch is new | program with two distinct net_fetch calls | two entries with different nodeIds |

### Group E — now / random_int (3)
| # | Name | Flow | Assertion |
|---|---|---|---|
| E1 | now() recorded then replayed | `let t = now(); let x = pause; print(t);` → resume | print outputs the t from first execution, not the resume-time now |
| E2 | random_int records and replays | similar pattern | resume returns recorded random |
| E3 | --time MS overrides now() on first execution | `let t = now(); print(t);` run with `--time 12345` | print outputs `12345` |

### Group F — read_file / write_file (3)
| # | Name | Flow | Assertion |
|---|---|---|---|
| F1 | read_file logs content and replays | `let c = read_file("/tmp/x"); let _ = pause; print(c);` → resume after deleting `/tmp/x` | print outputs original content (not file error) |
| F2 | write_file skipped on replay | Source: `write_file("/tmp/y", "first"); let _ = pause; print("done");`. (1) `pen run` writes `/tmp/y` = "first" and pauses. (2) Manually modify `/tmp/y` to "manual override". (3) `pen resume`. **Assertion**: `/tmp/y` content is still "manual override" — the first write_file was SKIPPED on replay (because it's already in the log). Print "done" appears. |
| F3 | write_file errors propagate first time | `write_file("/nonexistent/dir/file", "x");` | runtime error |

### Group G — wait_until / wait_for (5)
| # | Name | Flow | Assertion |
|---|---|---|---|
| G1 | wait_until pauses, resume after time continues | `wait_until(100); print("done");` → run pauses, sleep 200ms, resume → prints "done" | resume passes through |
| G2 | wait_until resume too early re-pauses | `wait_until(10000); print("done");` → run pauses, resume immediately → still paused | snapshot is still paused after attempt |
| G3 | wait_for + --event approval=true resumes | `let x = wait_for("approval"); print(x);` → run pauses, `pen resume <snap> --event approval=true` → prints `true` | event value injected |
| G4 | wait_for + --event with int value | `--event count=42` | wait_for returns int 42 |
| G5 | wait_for + --event with string value | `--event note=ok` ("ok" not numeric/bool, becomes str) | wait_for returns StrVal("ok") |

### Group H — Crash + recover end-to-end (5)
| # | Name | Description |
|---|---|---|
| H1 | print → pause → "crash" → resume | print not re-fired |
| H2 | net_fetch → pause → resume | log used; no network |
| H3 | wait_for at line 5, resume → pause again at line 10, resume again → finished | multi-pause flow with replay |
| H4 | **24h HITL demo** (the headline acceptance) | see §11.1 below |
| H5 | hash mismatch with --force still works | with effect log preserved |

### Group I — Fork (3)
| # | Name | Description |
|---|---|---|
| I1 | fork copies effect log | both branch snapshots have identical pre-fork log |
| I2 | post-fork divergence: each branch's new effects independent | branch 1's net_fetch doesn't appear in branch 2's log |
| I3 | invocationCount across fork: nodeId + count in branch 1 is independent of branch 2 | counts can collide in numbering but each branch's lookup is per-its-own-log |

### 11.1 The Headline Demo (H4) — 24h HITL Approval Agent

`examples/08-24h-agent.pen`:
```pen
let amount = 5000;
print("Approval request for $" + to_str(amount));
let decision = wait_for("approval");
print("Decision received: " + to_str(decision));
if decision { 
  let response = net_fetch("https://httpbin.org/uuid");
  print("LLM processed");
  write_file("/tmp/penelope-audit.log", response);
  print("Audit logged");
} else { 
  print("Denied. No action.");
}
```

Resume invocations:
```bash
# Crash 1 happens after the first print, snapshot at wait_for
pen resume examples/08-24h-agent.penz --event approval=true
# → prints "Decision received: true", "LLM processed", then crashes
# Crash 2 happens after "LLM processed" (we add a deliberate pause or accept the natural one)
pen resume examples/08-24h-agent.penz
# → write_file fires (first time, not in log), prints "Audit logged"
```

**Note:** as written, the program has only one pause point (`wait_for`). To make "two crashes" meaningful, the plan adds a second `pause;` between `print("LLM processed")` and `write_file`. The audit-write happens only on the second resume — by which point net_fetch is in the log and replays, while write_file fires fresh.

**Flow:**
1. `pen run examples/08-24h-agent.pen` → prints "Approval request: ..."; pauses at `wait_for`. Snapshot written.
2. **Crash 1** = just kill the process. The snapshot is on disk.
3. `pen resume examples/08-24h-agent.penz --event approval=true` → resume; print "Decision received" (NOT re-print "Approval request"); fetches; **the snapshot might pause again** if we add a deliberate pause; prints "Processed".
4. **Crash 2** = kill again. Snapshot updated.
5. `pen resume examples/08-24h-agent.penz` (no event needed if just continuing) → finishes: `write_file` writes the audit; print "Done".

**Acceptance**: stdout across all resumes contains each print line EXACTLY ONCE. `/tmp/penelope-audit.log` exists with the LLM response content exactly once. The `net_fetch` URL was hit exactly once (verifiable by checking the log entry).

---

## 12. File Layout — Diff from Phase 1

```
src/
  ast.ts            MODIFIED   add 'StringLit' AST node; add 'str' Value tag
  lexer.ts          MODIFIED   add STRING token + scanner; add new builtin idents
  parser.ts         MODIFIED   parsePrimary STRING case
  interpreter.ts    MODIFIED   add 'str' formatValue; add effect-builtin recognition
                                in 'invoke' case; add log indexing; reject reserved builtin
                                names in 'bindLet' (or earlier in Let case)
  snapshot.ts       MODIFIED   version 1 → 2; add effects field; error on v1
  cli.ts            MODIFIED   --event NAME=VALUE parsing; --time MS; --no-replay;
                                update cmdInspect to show effect log
  effects.ts        NEW        all real IO (curl, fs read/write, console.log, Math.random)

test/
  string.test.ts    NEW        Group A tests
  effect.test.ts    NEW        Group B tests
  integration.test.ts MODIFIED add Group C/D/E/F/G/H/I tests as cross-process integrations

examples/
  04-print-replay.pen   NEW    Group C demo
  05-net-fetch.pen      NEW    Group D demo
  06-now-random.pen     NEW    Group E demo
  07-wait-for.pen       NEW    Group G demo
  08-24h-agent.pen      NEW    H4 — the headline demo
```

---

## 13. Implementation Order (sketch — plan refines)

1. **Setup**: add 'str' to Value; bump snapshot to v2; reject v1; add `effects: []` to State (default empty); ensure Phase 1 still passes
2. **Strings — lexer + parser + interpreter**: scanner, StringLit, evaluation, `+` overload, `==/!=` overload, str_length, str_slice (Group A tests)
3. **Effects.ts module**: scaffold + categorization
4. **Reserved builtin guard**: reject `let net_fetch = ...` etc.
5. **Effect dispatch in invoke**: detect effect builtin → take effect path
6. **print as effect**: log entry + replay skip (Group C tests)
7. **read effects** (now / random_int / read_file / net_fetch): each as its own task (Groups D / E / F partial)
8. **write_file effect** (Group F)
9. **wait_until / wait_for effects + CLI --event flag** (Group G)
10. **Inspect with effect log** (Group B5)
11. **Crash + recover integration tests** (Group H)
12. **Fork preservation** (Group I)
13. **Headline 24h agent demo + integration test** (H4)
14. **README Phase 2 status**

Estimated: ~40-50 commits / tasks. Plan will lay out precise tasks.

---

## 14. Out of Scope (Phase 2, explicit)

- Effect type signatures in fn declarations
- User-defined effect handlers (handler/perform calculus)
- Network: methods beyond GET, retries, timeouts, headers, cookies, auth
- FS: append, delete, list, mkdir, stat
- Strings: interpolation, methods other than length/slice, regex, encoding
- Random: seeding (just record-and-replay in Phase 2)
- Time: timezones, formatting
- Concurrency, multi-threading, true async
- Modules / imports
- LSP, IDE support, formatter
- Bytecode VM (Phase 3)

---

## 15. Phase 3 Forward-Compatibility Notes

- `EffectEntry.effect` is a string; adding new effects is a string-table extension
- `State` has the log; switching to a more compact wire format later is a snapshot-version bump
- Splitting `effects.ts` from `interpreter.ts` lays the groundwork for Phase 3's handler-based architecture
- `--no-replay` exists as a debugging escape — Phase 3 might generalize to per-effect re-execution policies

---

## 16. Phase 2 Done Criteria

1. `vitest run` exits 0 — all Phase 1 tests still pass, all ~38 new tests pass
2. Manual reproduction of the 24h HITL demo (H4) from a fresh clone produces the expected outputs and one-time effects
3. README has a Phase 2 Status section
4. Conventional Commits throughout
5. Branch `feat/phase-2` merged to `main`
