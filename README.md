<p align="center">
  <img src="./assets/logo.svg" alt="Penelope — a language that knows how to wait" width="800">
</p>

<p align="center">
  <a href="https://github.com/airingursb/Penelope/actions"><img alt="tests" src="https://img.shields.io/badge/tests-613%20passing-brightgreen"></a>
  <a href="https://airingursb.github.io/Penelope/"><img alt="docs" src="https://img.shields.io/badge/docs-live-blue"></a>
  <a href="https://airingursb.github.io/Penelope/play.html"><img alt="playground" src="https://img.shields.io/badge/playground-browser-purple"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey"></a>
</p>

> **Execution is data. A running program is a value.**

Penelope makes pause/resume a **language primitive**, not a framework feature. A program can suspend itself mid-flight, write its complete state to disk, exit the process, and a later — possibly much later — invocation can pick up exactly where it left off, with full bindings and call stack intact.

```pen
let x = 10;
let y = pause;        // process exits, state saved to disk
print(to_str(x + y)); // a later process resumes with y = 5, prints 15
```

No `checkpoint`, no `await`, no decorator. Just `let y = pause;`. That is the entire ergonomic claim.

[**Read the docs**](https://airingursb.github.io/Penelope/) · [**Try in browser**](https://airingursb.github.io/Penelope/play.html) · [**Tour**](https://airingursb.github.io/Penelope/tour.html) · [**Debugger**](https://airingursb.github.io/Penelope/debugger.html)

---

## The thesis

In ordinary programming languages, a running program's mid-execution state is **ephemeral**. If the process dies, the state dies with it. The variables on the stack vanish. The half-finished computation is unrecoverable. You either start over, or you write a great deal of supporting code — checkpoint files, queues, retries, idempotency layers — to make the system survive failure.

Modern durable-execution frameworks (Temporal, Inngest, Restate, DBOS) add that infrastructure on top of ordinary languages. They work. They are also constraining: they force users to structure programs around `activity` / `step` / `await` boundaries. The programmer must mentally translate "what I want to do" into "what the framework will let me say."

Penelope dissolves these boundaries by making pause/resume a **language primitive**. The user writes straight-line code. The runtime handles all the durability.

---

## A second example: a 24-hour approval

```pen
print("Requesting approval");
let decision = wait_for("approval");           // process can die here
print("Decision: " + to_str(decision));
let result = net_fetch("https://example.com"); // process can die here
write_file("/tmp/audit.log", result);
print("Audit complete");
```

Run it; the process pauses on `wait_for`. The CI server can restart, the laptop can sleep, the cluster can be redeployed — the snapshot on disk holds the program's complete future. Hours or days later:

```sh
pen resume agent.penz --event approval=true
```

The program resumes. `decision` is bound to `true`. `print("Decision: true")` fires. `net_fetch` runs. If the process dies *again* after that, resuming a second time **replays the fetched response from the effect log** — the network is not hit twice. `write_file` runs exactly once across the whole lifetime, even if the program is resumed ten times.

This is the durable-execution contract you'd get from Temporal — written in a syntax that doesn't know it's durable.

---

## The name

In Homer's *Odyssey*, Penelope waits twenty years for Odysseus to return from the Trojan War. Pressed by a hundred suitors to remarry, she promises she will choose one when she finishes weaving a shroud for Laertes. By day, she weaves. By night, she unweaves what she has done. Year after year, until Odysseus comes home.

The myth maps onto the language:

| Myth | Language |
|---|---|
| Weave | Execute |
| Unweave | Rollback (via fork) |
| Dusk → dawn | Pause / resume |
| Twenty years | Durable execution at any timescale |
| The return | The program eventually completes, correctly |

She didn't have to wait — she *chose* to. A Penelope program does not stall; it deliberately holds its place, because it knows what it is waiting for.

---

## Quick start

```sh
git clone https://github.com/airingursb/Penelope
cd Penelope
npm install && npm run build

# Run a program
bin/penelope run examples/01-toplevel-pause.pen

# Compile to bytecode with -O2
bin/penelope build -O2 examples/09-fib.pen

# Inspect a snapshot
bin/penelope inspect examples/01-toplevel-pause.penz

# Type-check
bin/penelope check examples/08-24h-agent.pen

# Format
bin/penelope fmt examples/10-sort.pen

# Run a doctest
bin/penelope test examples/12-retry-agent.pen

# Drop into a REPL
bin/penelope repl

# Compare optimizer levels on a benchmark
bin/penelope bench examples/09-fib.pen
```

The CLI also supports `exec`, `resume`, `fork`, `disasm`, `profile`, `doc`, plus flags `-O0/-O1/-O2`, `--time N`, `--no-replay`, `--event N=V`, `--watch`. See the [CLI reference](https://airingursb.github.io/Penelope/cli.html).

---

## What ships today

**613 tests passing across 55 files.** Zero production dependencies. Hand-written everything. The five phases below are the user-facing organization — see the [Overview](https://airingursb.github.io/Penelope/) for the full capability table.

### Language

- **Pause as a first-class expression** — `let y = pause;` exits the process, writes a JSON snapshot. `pen resume` picks up where it left off, with full bindings and call stack intact.
- **Effect system** — 8 built-in effects (`print`, `net_fetch`, `now`, `random_int`, `read_file`, `write_file`, `wait_until`, `wait_for`) recorded in a per-IP log. Resume never double-fires.
- **Pattern matching** — literal / wildcard / var / or (`a | b | c`) / guard (`p if cond`) / list (`[a, ...rest]`) / dict (`{name: n}`) patterns.
- **Effect types** — every fn type carries an inferred effect set. `pure fn(...)` enforces an empty set; `pen check --show-effects` shows every fn's signature.
- **String interpolation** — `"hello ${name}, you are ${age + 1}"` desugars to a `+` chain with `to_str` wrapping.
- **Modules** — `import "./path.pen";` with file-relative paths, dedup, cycle-safety, and cross-import source maps for diagnostics.
- **TCO** — calls in tail position become `TAILCALL` (frame reuse). Deep tail recursion is bounded by heap, not stack.

### Runtime

- **Bytecode VM** — stack-based, 18 opcodes, frame chain, ip-keyed effect log. Snapshot format v3 (gzipped JSON).
- **5-pass optimizer** — constant folding, dead-code elimination, inline caches, function inlining, peephole. `-O0` / `-O1` / `-O2`.
- **JIT** — bytecode → JS Function at runtime. Op args baked as literals, `BIN_OP` specialized per operator. ~2.4× faster than the `-O2` interpreter on `fib(25)`. Snapshot semantics + effect replay + TCO preserved byte-for-byte.
- **Distributed runtime** — single-coordinator + multiple workers, HTTP/JSON protocol, lease + heartbeat for dead-worker recovery, `FileStore` for persistence across restarts.
- **Observability** — OpenTelemetry-shaped `Tracer` hook (`fn_call`, `fn_return`, `effect`, `pause`, `resume`, `error`). `pen run --trace` emits JSON-lines.

### Tooling

- **Self-hosting** — `std/lexer.pen` + `std/parser.pen` + `std/compiler.pen`. Verified by three-stage `pen self-test`: (1) pen-built ≡ ts-built bytecode on samples; (2) the pen frontend's own source round-trips; (3) the pen-built pen-frontend, when run, correctly compiles new programs.
- **Live editing** — `pen edit <snap.penz>` recompiles edited source and remaps the paused VMState via source-position lookup with opcode-kind sanity checks.
- **Time-travel debugger** — DAP `stepBack` + `reverseContinue` — VMState deep-cloned before every advance into a bounded history stack.
- **CLI** — `pen run / build / exec / resume / fork / edit / inspect / disasm / bench / profile / check / fmt / test / doc / graph / new / repl / coordinator / worker / submit / self-test`.
- **Editor integration** — full VSCode extension: syntax, LSP (hover, completions, go-to-def, diagnostics), DAP debugger (breakpoints, variables, time-travel), snippets.

---

## Architecture

```
.pen source
   │
   ▼ tokenize          ── lexer.ts (hand-written)
tokens
   │
   ▼ parse             ── parser.ts (recursive descent, Pratt precedence)
AST
   │
   ▼ compile           ── compiler.ts (one case per ASTNode kind)
bytecode (.penc)
   │
   ▼ optimize          ── optimizer.ts + optimizer/{constfold,dce,ic,inline,peephole}.ts
optimized bytecode
   │
   ▼ run               ── vm.ts (stack-based, frame chain, ip-keyed effect log)
VMState ⇄ snapshot v3  ── snapshot.ts (.penz JSON, sha256-pinned)
```

**Sister tooling**:

- `lsp.ts` — Language Server Protocol (hover, completions, go-to-definition, diagnostics)
- `dap.ts` — Debug Adapter Protocol (breakpoints, stack, variables)
- `typecheck.ts` — Static type checker
- `format.ts` — Source formatter
- `doc-gen.ts` — Markdown extraction from `///` comments
- `test-runner.ts` — `// EXPECT:` doctest harness
- `diagnostic.ts` — Rust-style error formatting
- `vscode-extension/` — Full editor integration

---

## The effect log

Every side-effect — `print`, `net_fetch`, `now`, `random_int`, `read_file`, `write_file`, `wait_until`, `wait_for` — flows through the **effect log** captured in the snapshot. On resume, completed effects are *replayed from the log*; they don't re-execute. This guarantees idempotency across pause boundaries.

```
$ pen run examples/08-24h-agent.pen
Requesting approval for $5000
paused at ip 12 → examples/08-24h-agent.penz

$ pen resume examples/08-24h-agent.penz --event approval=true
Decision received: true
LLM processed
paused at ip 27 → examples/08-24h-agent.penz

$ pen resume examples/08-24h-agent.penz
Audit logged
# Earlier prints are NOT repeated. net_fetch is NOT re-called.
```

---

## Examples

All 16 examples live in `examples/`. See the [Examples gallery](https://airingursb.github.io/Penelope/examples.html) for descriptions; the highlights:

- `01-toplevel-pause.pen` — top-level pause survives across processes
- `02-nested-pause.pen` — closure captures survive across resume
- `03-fork.pen` — two futures from one snapshot
- `04-print-replay.pen` — effects replayed, not re-executed
- `05-net-fetch.pen` — HTTP recorded once, replayed on resume
- `06-now-random.pen` — `now()` / `random_int()` deterministic via effect log
- `07-wait-for.pen` — external event injection
- `08-24h-agent.pen` — 24h HITL agent crashes twice, completes correctly
- `09-fib.pen` — recursive fib benchmark target
- `10-sort.pen` — bubble sort on lists
- `11-bfs.pen` — BFS over a dict-based graph
- `12-retry-agent.pen` — multi-attempt agent with `wait_for`
- `13-interp.pen` — string interpolation
- `14-match.pen` — vending-machine state machine via nested match
- `15-modules-main.pen` + `15-modules-math.pen` — module imports

---

## Project layout

```
src/                  Penelope implementation (TypeScript, zero deps)
  dist/               Distributed runtime (coordinator, worker, store)
  optimizer/          5 optimizer passes (constfold, dce, ic, inline, peephole)
  tracer.ts           OpenTelemetry-shaped tracer hook
  jit.ts              Bytecode → JS Function JIT
std/                  Penelope-implemented stdlib (lexer/parser/compiler — self-hosting)
bin/                  Shell launchers (penelope, penelope-lsp, penelope-dap)
docs/                 Specs, plans, internal references
docs-site/            Public documentation site (deployed via GitHub Pages)
examples/             .pen sample programs
test/                 Vitest test suite
vscode-extension/     Full VSCode extension (syntax, LSP, debugger, snippets)
scripts/              Build helpers (playground bundler, etc.)
assets/               Logo and other static assets
```

---

## Design choices

### Why TypeScript, not Rust or C++?

Penelope's thesis is "a paused program is just a value." To prove that, what matters is the **shape** of the runtime, the **discipline** of the snapshot format, and the **self-hosting fixpoint** — not raw throughput. TypeScript was chosen because:

- **Zero ceremony for the snapshot.** A Penelope snapshot is literally `JSON.stringify(state)`. In Rust I'd be writing `serde` derives, lifetime-juggling closure captures into an arena, and inventing a representation for `Value` that survives mmap. In TS, `Value` is a tagged record and `state.frames[0].bindings` already is `Record<string, Value>` — the language hands me a structural-sharing GC for free. The whole snapshot v3 design fits in ~80 lines because the host language and the guest language share a memory model.

- **Closures across the host/guest boundary.** The JIT (Phase 5.C) generates JS source and instantiates it as a `new Function(...)`. That gives me runtime codegen in 200 lines without an assembler, without LLVM bindings, without writing a relocatable object format. The pen-built code calls right back into the interpreter's `applyBinOp` / `executeEffect` because they're already in scope. In Rust this would be an FFI dance with `libloading` or `cranelift` — months of work for something the bench shows is already 2.4× faster than the interpreter.

- **The host is the platform.** Workers, coordinator, HTTP server (Phase 5.A), VSCode extension, LSP, DAP, web playground — all of these already live in the Node/browser ecosystem. Writing them in Rust would mean either compiling to WASM (and importing every Node API anyway) or maintaining parallel C bindings to V8. Zero gain.

- **Self-hosting is the destination, not TS.** Penelope already compiles Penelope (`pen self-test` proves it). The natural successor to the TS implementation is a Penelope-implemented runtime — not a Rust rewrite that would be obsolete the moment the self-hosted compiler can target WASM or native. The TS code is the bootstrap stage.

**What TypeScript costs**: ~2-3× slower than what a Rust interpreter would do; no AOT-to-native target; the JIT tops out at "as fast as V8 can JIT my JS source," which is good but not Rust+LLVM good. For a durable-execution language whose hot path is `wait_for("approval")` followed by a 24-hour sleep, that doesn't matter.

**When it would matter, and what we'd do**: if Penelope ever needs sub-microsecond pause/resume (high-frequency trading workflow? offline AI inference loop?), the right move is to compile the pen frontend's bytecode output to a target with a real native runtime — WASM via a hand-written Rust VM, or LLVM IR. The TS implementation stays as the reference; the self-hosted frontend ports unchanged because it doesn't care what executes its bytecode.

### Why JSON snapshots, not a binary format?

Same reasoning. JSON is debuggable (`pen inspect <snap.penz>` is `cat | jq`), trivially version-checkable, and gzips to within 10% of any custom binary format would achieve. The CPU cost of serialization is dwarfed by the cost of *running the program that produced the state*. A binary format becomes worth it only when serialization is the bottleneck — which it isn't for any realistic workflow.

### Why a stack-based VM, not registers?

The bytecode emitter falls out of the AST walker in one page of code. A register VM needs a register allocator (graph-coloring or linear scan), which is a real compiler pass with its own bugs and tradeoffs. For a language where the JIT already eliminates the dispatch overhead and the interpreter is plenty fast for IO-bound workflows, the simpler model wins on every axis except micro-benchmark throughput.

### Why no GC tuning?

The host language's GC handles it. When Penelope is rewritten in itself targeting a non-GC'd runtime, this will become a real problem. For now, the answer is "the same answer Node uses."

---

## License

MIT.

---

<p align="center"><sub>Built with discipline. 613 tests across 55 files. Self-hosted. <a href="https://github.com/airingursb/Penelope">github.com/airingursb/Penelope</a></sub></p>
