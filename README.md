# Penelope

> A language for programs that wait. And remember. And finish what they started.
>
> 一门为"会等待、会记得、能完成"的程序设计的语言。

**Status:** pre-code. Phase 1 in design. Brainstorming evaluator strategy now.

---

## The name

In Homer's *Odyssey*, Penelope waits twenty years for her husband Odysseus to return from the Trojan War. Pressed by a hundred suitors to remarry, she promises she will choose one when she finishes weaving a shroud for Laertes, her father-in-law.

By day, she weaves.
By night, she unweaves what she has done.

For twenty years. Until Odysseus comes home.

This language is named after that act. Not because computation is heroic — but because every Penelope program does what she did: **hold its place, faithfully, across whatever interruption time brings, until the work is done.**

A Penelope program does not stall. It does not crash and lose its way. It pauses, deliberately, with full knowledge of what it is waiting for — and resumes when the moment is right. Across an hour. Across a year. Across a process boundary. Across a machine reboot. Across a generation of hardware.

---

## The thesis

In ordinary programming languages, a running program's mid-execution state is **ephemeral**. If the process dies, the state dies with it. The variables on the stack vanish. The half-finished computation is unrecoverable. You either start over, or you write a great deal of supporting code — checkpoint files, queues, retries, idempotency layers — to make the system survive failure.

Modern durable-execution frameworks (Temporal, Inngest, Restate, DBOS) add that infrastructure on top of ordinary languages. They work. They are also constraining: they force users to structure programs around **`activity` / `step` / `await`** boundaries. The programmer must mentally translate "what I want to do" into "what the framework will let me say."

Penelope dissolves these boundaries by making pause/resume a **language primitive**, not a framework feature.

The user writes straight-line code. The runtime handles all the durability.

```pen
let x = 10;
let y = pause;        // process exits, state saved to disk
print(x + y);         // a later, separate process resumes with y = 5, prints 15
```

The variable `x` survives across processes. The user wrote no `checkpoint`, no `restore`, no `await`. Just: `let y = pause`. That is the entire ergonomic claim.

---

## A second example — a 24-hour approval

```pen
fn approve(amount: int) {
  print("Requesting approval for $" + amount);
  let decision = pause-on("approval");   // could be 5 minutes; could be 3 days
  
  if decision {
    process_payment(amount);
    print("Approved and paid.");
  } else {
    print("Denied.");
  }
}

approve(5000)
```

No `await`. No callback. No resumption boilerplate. The function looks synchronous because it *is* synchronous — Penelope just disagrees with ordinary languages about what "synchronous" means with respect to time.

If the process dies between `pause-on` and the response arriving, no work is lost. If the machine reboots, a resumed Penelope program picks up the approval and continues. The user wrote one function. The runtime handled the rest.

---

## The foundational axiom

> **Execution is data. A running program is a value.**

This is Penelope's "E = mc²". Every feature in the language is a logical consequence of this single axiom — not an added decision.

| Language | Axiom | Consequences |
|---|---|---|
| Lisp | Code is data | Macros, AST manipulation, self-hosting compilers |
| Smalltalk | The system is data | Image-based development, live debugging |
| Erlang | Processes are first-class | Distributed fault-tolerant systems |
| **Penelope** | **Execution state is data** | **Durable computation as a primitive** |

Each of these axioms generated a generation of programs. Penelope's bet is that *execution-as-data* generates the generation of programs the agent era requires.

---

## The defining one-liner

> **Penelope is to time what GC is to memory.**

Garbage collection freed programmers from manual memory management. Before GC, every programmer wrote `malloc` and `free` and was personally responsible for not corrupting the heap. After GC, that became the runtime's job.

Penelope frees programmers from manual *time* management. Before Penelope, every long-running program was responsible for:

- Writing checkpoint files
- Restoring state on startup
- Managing queues for delayed work
- Scheduling crons
- Building idempotent retries
- Threading through partial failures

After Penelope, that becomes the runtime's job.

The new contract is: **you write straight-line code; the runtime guarantees this code can pause, resume, crash, recover, wait for a decade, be forked into two futures, be moved between machines, and complete faithfully.**

This is one phase shift in the abstraction stack. Like garbage collection. Like virtual memory. Like file systems. Once it exists, you don't go back.

---

## The eight pillars

Each pillar is a logical consequence of the axiom. None is added on top.

### 1. Continuations are first-class values

Not "`pause` returns a value." The entire forward execution, captured at the moment of `pause`, is itself a value. You can store it in a variable, pass it to a function, write it to a database, send it over the network.

Scheme's `call/cc` did this halfway: continuations were first-class within a process, but couldn't be serialized, couldn't survive a process exit, couldn't be shipped elsewhere. Penelope completes the line: continuations are *serializable* first-class values.

### 2. Time is a coordinate, not a current

Most languages encode the physical intuition that time flows one way. A process runs forward; the past is gone; the future is unrun.

In Penelope, every saved snapshot is a point in time you can return to. `undo` is a language operator. `replay-from(t)` is a language operator. `fork-at(t)` is a language operator. A Penelope program's *real* execution is not a single line — it is a tree of possibilities, and the observed run is one path among many.

This means: debugging is not "add prints and rerun." Debugging is *standing at the moment before the bug, with all variables visible, choosing where to go from here.*

### 3. Code, queue, database, and cron boundaries dissolve

When pause is free, these all collapse into trivialities:

- **A queue**: `List<Continuation>`. Enqueue = push. Work = pop and resume.
- **A cron job**: `loop { work(); pause-until(next_tick) }`.
- **A database row**: a serialized continuation.
- **A workflow engine**: the language itself.
- **"Schedule this for next Tuesday"**: `pause-until("2026-05-26")`.

Sidekiq, Celery, Airflow, cron daemons, Redis-backed queues, message brokers — most of the infrastructure that exists because ordinary languages can't pause — collapses into a few language constructs.

### 4. Errors are conversations, not cliffs

An exception in Penelope is just a `pause` that carries an error payload. The outside world — a human operator, another program, a recovery script — can inspect the snapshot, modify the variable that caused the failure, and resume.

This is Common Lisp's condition/restart system completed: serialized, remote-able, async-friendly. **"Production exception goes to the operator's inbox; they fix it; the program continues"** becomes a default capability, not a custom integration.

### 5. Code and runtime mutate together

Pause execution. Edit the AST. Resume. The function from that point forward runs against the new code.

Hot reload is not a framework feature. Live patching is not exotic. They are direct consequences of the axiom — code is data, runtime is data, both can be edited while paused.

### 6. Distribution is trivial — state is portable

Moving an execution between machines is moving a JSON file. A "process" is a Penelope runtime running some snapshot on some host. Scaling = sharding snapshots across hosts. The 1990s dream of *mobile agents* (Telescript-era) becomes natural again, because the underlying primitive — transportable execution — actually exists in the language.

### 7. Determinism is the foundation

For pause/resume to be correct, execution must be replayable. Side effects must be tracked, logged, or banned.

**This is why Phase 2's effect system is not a "safety" feature — it is a correctness feature.** Without effect tracking, pause/resume only works for pure code, which is useless. The effect system is what allows Penelope to know, on resume: this `Net.fetch` must *not* re-fire (we already got the response, here it is); this `Random` must use the same seed; this `Now()` must return the same moment it returned the first time.

Determinism is not optional. It is the ground every other property stands on.

### 8. The agent is the native citizen

Most languages were designed for human programmers writing synchronous business logic. Agents — long-running, partially autonomous executors that wait on humans, on models, on slow systems — are bolted on after the fact. See LangGraph fighting Python's execution model; see crewAI's `await asyncio.sleep` for human input.

Penelope is designed for them from the start. **An agent is just a Penelope program.** Auditing = reading snapshot history. Forking = `fork(snapshot)`. Human-in-the-loop = handling a `pause`. The framework you would have built around Python is, in Penelope, the language itself.

If your work involves agents that must wait, recover, audit, branch, or coordinate with humans — Penelope is the substrate.

---

## What Penelope is *not*

Every philosophy has a cost. Penelope's:

- **Not fast.** Tree-walking interpreters are slow. Serialization-friendly state representations cost more than register-level execution. Performance arrives in Phase 3 (bytecode VM). For real-time, game loops, or HFT — look elsewhere.
- **Not unrestricted.** Side effects must be tracked. You cannot drop in an arbitrary C library and have it Just Work. Every effect needs a vetted representation that knows how to behave under replay.
- **Not for one-off scripts.** Penelope shines when programs live for weeks, years, or generations. For a 50-millisecond shell utility, it's overkill.
- **Not a competitor to Rust, Go, or Python.** Penelope does not compete with general-purpose languages. It competes with Temporal, Airflow, Inngest, Sidekiq, Celery, cron daemons — and the long tail of "infrastructure people built because their language couldn't pause."

Knowing what a language is *not* is as important as knowing what it is. Penelope is not the right tool for most programs. It is the right tool for *some* programs that today require ten thousand lines of supporting infrastructure to merely exist.

---

## Where Penelope sits in the landscape

The space is sparse, but not empty.

| Project | Approach | Difference from Penelope |
|---|---|---|
| **Unison** | Content-addressed values, including closures, are serializable | Headline is content-addressing; durability is downstream. Penelope's headline is `pause`. |
| **Golem Cloud** | Durable runtime layer over any WASM language | Runtime, not language. Same destination, different vehicle. |
| **WasmFX / Wasm stack-switching proposal** | Platform-level typed continuations | A substrate Penelope could ride. No language has shipped serializable cross-process continuations on it yet. |
| **Temporal / Inngest / Restate / DBOS** | Framework-shaped durable execution | The user must structure code into activities. Penelope dissolves that. |
| **Scheme `call/cc`** | First-class in-process continuations | Not serializable across processes. Penelope completes the half-finished work. |
| **Effect handlers (Koka, Effekt, OCaml 5)** | Resumable continuations within a process | No cross-process persistence. Penelope is what you get when you add disk to this idea. |

**Penelope's position: "Temporal as a language." The position no one has taken yet.**

---

## Roadmap

### Phase 1 — Prove the axiom *(current)*

A deliberately tiny language: integers, booleans, `let`, arithmetic, comparison, `if`/`else`, function definitions and calls, `print`, and the special primitive `pause`. Hand-written lexer and recursive-descent parser. Tree-walking interpreter in TypeScript on Node.

The hard part is not the language. It is the interpreter's state representation. A naive recursive evaluator uses the JS call stack — which cannot be JSON-serialized. So the evaluator must *reify* "where we are" as plain data: explicit-stack trampoline, continuation-passing style, or a small step-machine. This is the most important open design decision, to be locked before any code is written.

**Phase 1 acceptance demos (all three must pass):**

1. **Top-level pause** — `x` survives across processes.
2. **Nested-function pause** — pausing deep in a call stack correctly serializes outer frames and resumes through them.
3. **Fork a snapshot** — the same paused state, resumed twice with different values, produces two different futures. Proves snapshot is a value, not implicit state.

### Phase 2 — Effect system *(future)*

Not "adding types." Adding **correctness for pause/resume in impure code.** Effects appear in function signatures. The runtime knows, on resume, what to replay and what to skip. The acceptance demo: a 24-hour await-human-reply program that survives two mid-flight crashes and still completes correctly.

### Phase 3 — Bytecode VM, derivative features *(future)*

Performance through a real VM. Plus the long-promised consequences of the axiom:

- **Live editing**: pause → patch the AST → resume against the new code.
- **Time-travel debugger**: built into the language, not bolted on.
- **Distributed snapshot migration**: ship snapshots between machines as JSON, resume on the destination.

### Phase 4 — Self-hosting *(future)*

Penelope written in Penelope. The compiler itself pausable: pause mid-compile, edit your source, resume against the new code. No other language can do this in principle. The loop closes.

---

## Glossary

A few terms to align on. Mythological flavor lives in branding; the API stays technical.

| Term | Meaning |
|---|---|
| **`pause`** | The language primitive. Captures forward execution as a serializable value. |
| **Snapshot** | The captured state. A `.pen` file on disk is one snapshot. |
| **Continuation** | The in-memory runtime form of a snapshot. |
| **Resume** | Restart a continuation, supplying the value `pause` should return. |
| **Fork** | Clone a snapshot. Two independent resumes from the same paused moment. |
| **Replay** | Walk through a snapshot's execution without re-firing side effects. |
| **`.pen`** | File extension for a saved snapshot. |

Functions are still written `fn`. Variables are still `let`. Penelope is the *posture* of the language, not the spelling of every primitive.

---

## How to read this repo

- **`CLAUDE.md`** — canonical project spec: axiom, pillars, Phase 1 deliverable, design constraints, implementation guidance. The source of truth for anyone working on Penelope.
- **`README.md`** — this file. The public version. Heavier on philosophy and context.
- **`src/`** — Phase 1 code, once the evaluator strategy is locked in. *(Not yet committed.)*
- **`examples/`** — runnable `.pen` demonstrations. *(Not yet committed.)*

---

## A note on prior names

This project was briefly called **AIR** (a recursive acronym, "AIR Is Resumable") and then **Amber** (for the fossilization metaphor). Both were withdrawn — `AIR` because "air" connoted ephemerality and worked against the thesis; `Amber` after research surfaced naming conflicts with `amber-lang/amber` (a 4.3k★ Bash transpiler) and a 2026-04 Show HN agent runtime also named Amber.

The current name was chosen for its mythological grounding in the language's core act: faithful, deliberate, long-duration waiting.

---

## License

TBD.
