# pirobos

[English](./README.md) | [한국어](./README.ko.md)

Native [Ouroboros](https://github.com/Q00/ouroboros) loop for [pi](https://github.com/badlogic/pi-mono).

This is **not** a wrapper around the `ouroboros` Python CLI. The spec-first
loop (interview → seed → evaluate → drift → unstuck → ralph) is implemented
directly inside pi as a TypeScript extension. State lives in `.ouroboros/`
under your project, `seed.yaml` is human-readable and compatible with the
upstream Ouroboros format.

## Coding harness

Whenever this extension is loaded, it injects the [Karpathy coding
guidelines](https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md)
(Think Before Coding · Simplicity First · Surgical Changes · Goal-Driven
Execution) into the system prompt. They are bundled inline in `index.ts`
(`KARPATHY_HARNESS`); to disable, comment out that constant from the prompt
block.

## What it ports

| Concept    | Implementation in this extension                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| Seed       | `.ouroboros/seed.json` (canonical) + `seed.yaml` (mirror). Locked once finalized.                       |
| Interview  | `before_agent_start` injects a Socratic directive; LLM records via `ooo_seed_set` / `ooo_seed_finalize`. |
| Evaluate   | Mechanical (auto-detect `npm test` / `pytest` / `make test` / `cargo test` / `go test`) + semantic AC grading via `ooo_grade_ac`. |
| Drift      | LLM self-reports goal/constraint/ontology in [0,1]; weighted 0.5 / 0.3 / 0.2; threshold ≤ 0.30.        |
| Unstuck    | 5 lateral personas (inverter, first-principles, naive-newcomer, adversary, architect) injected via system prompt for 3 turns. |
| Ralph      | After each turn, auto-sends a follow-up to evaluate-and-continue until ACs converge or the cap (default 8) is hit. |

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

## Slash commands

| Command                | Effect                                                                  |
| ---------------------- | ----------------------------------------------------------------------- |
| `/ooo-interview <goal>` | Start the Socratic interview for a goal.                               |
| `/ooo-seed`            | Print the locked seed (or current draft).                              |
| `/ooo-evaluate`        | Run the mechanical test runner + ask the LLM to grade each AC.         |
| `/ooo-drift`           | Ask the LLM to self-assess drift vs the locked seed.                   |
| `/ooo-unstuck [id]`    | Switch to a lateral persona for 3 turns. With no arg, opens a picker.  |
| `/ooo-ralph [on\|off\|N]` | Toggle the auto follow-up loop. `N` sets the turn cap.               |
| `/ooo-status`          | Print interview / seed / persona / ralph / drift status.               |
| `/ooo-reset`           | Clear session state (does not delete the locked seed).                 |

## LLM-callable tools

| Tool                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `ooo_seed_set`      | Merge-update the in-progress seed draft during the interview.        |
| `ooo_seed_finalize` | Lock the draft into `seed.yaml`. Requires ambiguity ≤ 0.2 and ≥ 5 ACs. |
| `ooo_grade_ac`      | Record verdict (pass / fail / n/a) on a single AC during evaluate.   |
| `ooo_record_drift`  | Record drift components and weighted score.                          |

## Lifecycle

`session_start` loads `.ouroboros/state.json` and `seed.json`. `before_agent_start`
appends a context block to the system prompt with the current seed, interview
state, persona, and ralph status. `agent_end` decrements the persona budget,
counts interview turns, and (if ralph is on) injects the next evaluate-and-continue
follow-up — bounded by the cap.

## Files

```
.ouroboros/
├── seed.json        # canonical seed (read by extension)
├── seed.yaml        # human / Ouroboros-compatible mirror
├── state.json       # interview/persona/ralph/AC-grades/drift
└── interview.jsonl  # transcript of seed_set / finalize events
```

## Glossary

- **Hard cap** — Ralph's absolute upper bound on iterations (default `8`,
  overridable via `/ooo-ralph on <N>`). When the loop hits the cap without
  every AC passing, ralph turns itself off and reports the failing ACs
  instead of looping forever. "Hard" because the agent cannot raise or
  bypass it mid-run; the user must explicitly restart with a new cap.
- **Scope creep** — Drifting beyond the locked seed: adding ACs the seed
  did not promise, refactoring code the task did not require, or chasing
  hypothetical future needs. The Karpathy harness ("simplicity", "surgical
  changes") and the locked seed are the two gates against it: if a change
  isn't traceable to a current AC, it doesn't ship in this loop. To
  legitimately expand scope, run `/ooo-interview` again to revise the seed.

## Notes

- Zero npm deps beyond the pi extension API. YAML is hand-serialized; the
  extension reads from the JSON sidecar to avoid pulling in a YAML parser.
- The mechanical evaluator runs `npm test --silent` if `package.json#scripts.test`
  exists, else `pytest -q`, else `make test`, else `cargo test --quiet`, else
  `go test ./...`. Override by patching `detectMechanical` in `index.ts`.
- Ralph has a hard turn cap (default 8) and stops automatically; it never
  loops indefinitely.
- A new `/ooo-interview` while a seed is already locked creates a *new* draft
  but does not modify the existing `seed.yaml`. Re-run `ooo_seed_finalize` to
  overwrite.
