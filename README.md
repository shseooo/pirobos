# pirobos

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md)

Native [Ouroboros](https://github.com/Q00/ouroboros) loop as a [pi](https://github.com/badlogic/pi-mono)
extension.

This is **not** a wrapper around the `ouroboros` Python CLI. The spec-first
loop (interview → seed → evaluate → drift → unstuck → ralph) is implemented
directly inside pi as a TypeScript extension. State lives in `.ouroboros/`
under your project; the [Karpathy coding harness](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)
is bundled inline in `index.ts` and is injected into the system prompt
**only when a seed is locked**, so pre-spec sessions stay un-augmented.

`.ouroboros/` is byte-compatible with [clauroboros](https://github.com/shseooo/clauroboros)
(the Claude Code port), so you can switch agents on the same project
without re-doing the interview.

## Install

```sh
# clone
git clone https://github.com/shseooo/pirobos.git
cd pirobos && npm install

# project-local install
mkdir -p .pi/extensions
ln -s "$(pwd)" .pi/extensions/pirobos

# or global install
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pirobos
```

Then `/reload` in pi.

## What it ports

| Concept    | Implementation in this extension                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| Seed       | `.ouroboros/seed.json` (canonical) + `seed.yaml` (mirror). Locked once finalized.                       |
| Interview  | `before_agent_start` injects a Socratic directive; LLM records via `ooo_seed_set` / `ooo_seed_finalize`. |
| Evaluate   | Mechanical (auto-detect `npm test` / `pytest` / `make test` / `cargo test` / `go test`) + semantic AC grading via `ooo_grade_ac`. |
| Drift      | LLM self-reports goal/constraint/ontology in [0,1]; weighted 0.5 / 0.3 / 0.2; threshold ≤ 0.30.        |
| Unstuck    | 5 lateral personas (inverter, first-principles, naive-newcomer, adversary, architect) injected via system prompt for 3 turns. |
| Ralph      | `agent_end` auto-sends a follow-up via `sendUserMessage({deliverAs:"followUp"})` until ACs converge or the cap is hit. |
| Harness    | `KARPATHY_HARNESS` constant in `index.ts`, prepended to the system prompt by `before_agent_start` only when a seed is locked. |

## Glossary

- **Seed** — Immutable spec: goal + acceptance criteria + constraints +
  ontology + exposed assumptions. Once locked, every command treats it as
  authority. Stored as `seed.json` (canonical) + `seed.yaml` (mirror).
- **Acceptance Criterion (AC)** — A single verifiable statement that
  defines part of "done". Each AC is graded `pass` / `fail` / `n/a` by
  either mechanical tests or by inspecting the codebase. A seed needs ≥ 5
  ACs before it can lock.
- **Ambiguity score** — 0–1 measure of how fuzzy the spec still is during
  the interview. The seed locks only when ambiguity ≤ 0.2.
- **Constraint** — Non-functional bound the solution must respect
  (performance, security, compatibility, dependency policy, etc.).
- **Ontology** — Term → definition map that pins down project-specific
  vocabulary, so every command and AC refers to the same concept.
- **Persona** — One of 5 lateral-thinking lenses for breaking out of stuck
  states: `inverter`, `first-principles`, `naive-newcomer`, `adversary`,
  `architect`. Recorded in `state.json` and decremented automatically by
  the `agent_end` hook over 3 turns.
- **Drift** — Divergence between current work and the locked seed,
  weighted as `0.5*goal + 0.3*constraint + 0.2*ontology`. ≤ 0.30 is OK;
  over = DRIFTED.
- **Ralph** — Self-driven evaluate-and-fix loop. After each `agent_end`,
  pirobos auto-injects the next `/ooo-evaluate` follow-up until every AC
  passes (CONVERGED) or the cap is hit.
- **Hard cap** — Maximum number of `/ooo-ralph` iterations before a
  forced stop (default 8, overridable via `/ooo-ralph on <N>`). Prevents
  runaway loops; if ACs haven't converged at the cap, ralph stops and
  reports honestly instead of weakening ACs to fake success. "Hard"
  because the agent cannot raise or bypass it mid-run.
- **Scope creep** — Gradual divergence from the locked seed: extra
  features, broadened goal, redefined terms, or constraints quietly
  relaxed. Detected via `/ooo-drift`. The seed is a boundary, not a
  suggestion — if the goal truly changed, stop and re-run
  `/ooo-interview` rather than expanding silently.
- **Karpathy harness** — Coding behavioral guidelines (think first,
  surgical changes, define success criteria, expose assumptions) bundled
  inline in `index.ts` (`KARPATHY_HARNESS`). Injected into the system
  prompt by `before_agent_start` only when a seed is locked.
- **Hard evaluate gate** — pi-specific: `tool_call` hook returns
  `{block: true}` for `edit` / `write` / `notebook_edit` when no seed is
  locked. Forces interview-before-code on every project.
- **Session lock** — `.ouroboros/.lock` is created atomically (`fs.openSync`
  with `wx`) on session_start. Concurrent pi sessions in the same project
  fail loudly instead of corrupting state.

## Slash commands

| Command                | Effect                                                                  |
| ---------------------- | ----------------------------------------------------------------------- |
| `/ooo-interview <goal>` | Start the Socratic interview to crystallize a seed.                    |
| `/ooo-seed`            | Print the locked seed (or current draft).                              |
| `/ooo-evaluate`        | Run the mechanical test runner + grade each AC with file-level evidence.|
| `/ooo-drift`           | Self-assess drift vs the locked seed.                                  |
| `/ooo-unstuck [id]`    | Switch to a lateral persona for 3 turns. With no arg, opens a picker.  |
| `/ooo-ralph [on\|off\|N]` | Toggle the auto follow-up loop. `N` sets the turn cap.               |
| `/ooo-status`          | Print interview / seed / persona / ralph / drift status.               |
| `/ooo-reset`           | Clear session state (the locked seed is preserved).                    |

## LLM-callable tools

| Tool                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `ooo_seed_set`      | Merge-update the in-progress seed draft during the interview.        |
| `ooo_seed_finalize` | Lock the draft into `seed.yaml`. Requires ambiguity ≤ 0.2 and ≥ 5 ACs. |
| `ooo_grade_ac`      | Record verdict (pass / fail / n/a) on a single AC during evaluate.   |
| `ooo_record_drift`  | Record drift components and weighted score.                          |

## When to use each command

| Situation                                                  | Command                  |
| ---------------------------------------------------------- | ------------------------ |
| Starting a new feature/task with a fuzzy goal              | `/ooo-interview <goal>`  |
| Want to inspect the current spec (locked or draft)         | `/ooo-seed`              |
| Just finished a meaningful work step — verify against ACs  | `/ooo-evaluate`          |
| Suspect scope creep after several edits                    | `/ooo-drift`             |
| Stuck, looping, or generating low-quality solutions        | `/ooo-unstuck [persona]` |
| Want autonomous push-to-green within a hard cap            | `/ooo-ralph [N]`         |
| Forgot where you are in the loop                           | `/ooo-status`            |
| Want to clear in-progress state but keep the seed          | `/ooo-reset`             |

### Picking a persona for `/ooo-unstuck`

| You are stuck because…                       | Persona            |
| -------------------------------------------- | ------------------ |
| The design feels overcomplicated             | `inverter`         |
| You've patched on top of a bad foundation    | `first-principles` |
| The codebase is foreign and assumptions hide | `naive-newcomer`   |
| You can't tell if the solution is correct    | `adversary`        |
| Module boundaries feel wrong                 | `architect`        |

### Loop-level guidance

- Run `/ooo-interview` **before writing any code** for a non-trivial task.
  The hard evaluate gate enforces this: `Edit` / `Write` are blocked until
  a seed locks, so you can't accidentally start coding without a spec.
- Run `/ooo-evaluate` as the gate before claiming "done" — never
  self-declare done without a graded AC tally.
- Run `/ooo-drift` periodically (every few edits, or after a refactor) —
  it's cheap and catches scope creep early.
- Use `/ooo-ralph` when the remaining work is mechanical (failing ACs
  with clear fixes), **not** when ACs are wrong. If an AC is wrong, stop
  and re-run `/ooo-interview` to revise the seed; never weaken ACs to
  converge.

## Pi extension features pirobos uses

Unlike Claude Code, pi exposes per-turn lifecycle hooks. pirobos leans on
them for stricter enforcement than `clauroboros` can offer:

- **Per-turn system prompt injection** via `before_agent_start` — the
  Karpathy harness, current seed, interview state, persona, and ralph
  status are appended to the system prompt every turn (only when a seed
  is locked).
- **Cross-turn auto follow-up** via `agent_end` +
  `pi.sendUserMessage(..., {deliverAs:"followUp"})` — Ralph runs as a
  natural multi-turn loop instead of a single extended command.
- **Hard evaluate gate** via `tool_call` returning `{block:true}` —
  `Edit` / `Write` / `NotebookEdit` are refused with a reason until a
  seed is locked. No "sneaking past" the spec.
- **Session lock** via atomic `fs.openSync(.lock, "wx")` — concurrent pi
  sessions in the same project fail with an explicit error instead of
  silently racing on `state.json`.
- **Local-only telemetry** at `.ouroboros/telemetry.jsonl` — ambiguity
  samples and ralph convergence/cap events are appended for personal
  analysis. Never sent off the machine.

## State files

```
.ouroboros/
├── seed.json        # canonical seed (read by extension as authority)
├── seed.yaml        # human / Ouroboros-compatible mirror
├── state.json       # interview / persona / ralph / acGrades / drift
├── interview.jsonl  # append-only event log of seed_set / finalize
├── telemetry.jsonl  # local-only ambiguity & ralph events
└── .lock            # atomic write lock; auto-removed on session_shutdown
```

## Files in this extension

```
pirobos/
├── index.ts         # extension entry — events, commands, tools, harness
├── package.json     # pi-ai + pi-coding-agent deps, MIT license
├── tsconfig.json    # local typecheck only (pi runs TS itself)
├── LICENSE          # MIT
└── README{.md,.ko.md,.ja.md}
```

## Example workflow

```
1. /ooo-interview "build a todo CLI"
   → agent runs a Socratic interview, one question at a time
   → each answer calls ooo_seed_set, updating the draft in state.json
   → at ambiguity ≤ 0.2 and AC ≥ 5, ooo_seed_finalize locks seed.json + seed.yaml

2. (write code — Edit/Write are now allowed because the seed is locked)

3. /ooo-evaluate
   → auto-detects + runs npm test / pytest / make test / cargo test / go test
   → grades each AC with file-level evidence via ooo_grade_ac
   → prints pass / fail tally

4. /ooo-drift
   → self-assesses goal / constraint / ontology divergence
   → weighted ≤ 0.30 is OK, otherwise DRIFTED

5. (when stuck) /ooo-unstuck adversary
   → activates a 3-turn persona that tries to break the current solution

6. /ooo-ralph on 8
   → after each agent_end, auto-injects /ooo-evaluate as a follow-up
   → fixes failing ACs surgically until CONVERGED or cap=8 reached
```

## Notes

- Zero npm deps beyond `@mariozechner/pi-ai` and
  `@mariozechner/pi-coding-agent`. YAML is hand-serialized; the extension
  reads from the JSON sidecar to avoid pulling in a YAML parser.
- The mechanical evaluator runs `npm test --silent` if
  `package.json#scripts.test` exists, else `pytest -q`, else `make test`,
  else `cargo test --quiet`, else `go test ./...`. Override by patching
  `detectMechanical` in `index.ts`.
- Ralph hard-caps at the user's chosen N (default 8). It will never
  disable ACs to "converge" — it stops and reports if it can't pass them
  honestly.
- A new `/ooo-interview` while a seed is already locked creates a *new*
  draft but does not modify the existing `seed.yaml`. Re-run
  `ooo_seed_finalize` to overwrite.
