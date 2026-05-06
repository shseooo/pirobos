/**
 * pi-ouroboros — native Ouroboros loop for pi.
 *
 * Ports the spec-first Ouroboros workflow (interview → seed → evaluate → drift
 * → unstuck → ralph) into pi as a self-contained TypeScript extension. No
 * external `ouroboros` CLI, no MCP server. State lives in `.ouroboros/`.
 *
 * Concepts ported (https://github.com/Q00/ouroboros):
 *   • Seed       — immutable spec (goal, ACs, constraints, ontology, ambiguity)
 *   • Interview  — Socratic loop that exposes assumptions before coding
 *   • Evaluate   — mechanical (tests) + semantic (LLM grades each AC)
 *   • Drift      — weighted goal/constraint/ontology divergence vs seed
 *   • Unstuck    — 5 lateral-thinking personas swap the system-prompt persona
 *   • Ralph      — auto follow-up loop until ACs converge (with hard cap)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, StringEnum } from "@mariozechner/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// ────────────────────────────────────────────────────────────── personas ──

const PERSONAS = {
	inverter: {
		label: "Inverter",
		prompt:
			"Assume the OPPOSITE of every requirement. For each acceptance criterion, what changes if it were inverted? Which requirements turn out to be load-bearing vs ornamental?",
	},
	"first-principles": {
		label: "First-Principles",
		prompt:
			"Strip the problem down to physical, mathematical, or logical fundamentals. Forget the existing approach entirely. Reconstruct from base axioms only.",
	},
	"naive-newcomer": {
		label: "Naive Newcomer",
		prompt:
			"Pretend you have never seen this codebase. Explain it from zero, asking dumb questions out loud. Surface every implicit assumption that isn't documented.",
	},
	adversary: {
		label: "Adversary",
		prompt:
			"Actively try to BREAK the current solution. Find inputs, edge cases, race conditions, malformed configs, and security holes that would defeat it.",
	},
	architect: {
		label: "Architect",
		prompt:
			"Zoom out. Forget the current module boundaries — redraw them. What if the seams were drawn somewhere else entirely?",
	},
} as const;

type PersonaId = keyof typeof PERSONAS;
const PERSONA_IDS = Object.keys(PERSONAS) as PersonaId[];

// ────────────────────────────────────────────────────────────────── state ──

const STATE_DIR = ".ouroboros";

interface Seed {
	goal: string;
	acceptance_criteria: string[];
	constraints: string[];
	ontology: Record<string, string>;
	assumptions_exposed: string[];
	ambiguity: number;
	created_at: string;
	locked: boolean;
}

interface ACGrade {
	index: number;
	criterion: string;
	verdict: "pass" | "fail" | "n/a";
	evidence: string;
	at: string;
}

interface State {
	seedDraft: Partial<Seed> | null;
	interview: { active: boolean; turns: number; goal: string } | null;
	persona: PersonaId | null;
	personaTurnsLeft: number;
	ralph: { active: boolean; turn: number; cap: number } | null;
	acGrades: ACGrade[];
	drift: {
		goal: number;
		constraint: number;
		ontology: number;
		weighted: number;
		notes: string;
		at: string;
	} | null;
}

const RALPH_DEFAULT_CAP = 8;

function emptyState(): State {
	return {
		seedDraft: null,
		interview: null,
		persona: null,
		personaTurnsLeft: 0,
		ralph: null,
		acGrades: [],
		drift: null,
	};
}

function paths(cwd: string) {
	const dir = path.join(cwd, STATE_DIR);
	return {
		dir,
		state: path.join(dir, "state.json"),
		seedJson: path.join(dir, "seed.json"),
		seedYaml: path.join(dir, "seed.yaml"),
		interview: path.join(dir, "interview.jsonl"),
		lock: path.join(dir, ".lock"),
		telemetry: path.join(dir, "telemetry.jsonl"),
	};
}

function ensureDir(cwd: string): void {
	fs.mkdirSync(paths(cwd).dir, { recursive: true });
}

// Cross-session write lock. Atomic open with `wx` flag — fails with EEXIST
// when another session already holds `.ouroboros/.lock`. Stale-PID locks are
// reclaimed automatically.
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
}

type LockResult = { ok: true } | { ok: false; reason: string };

function acquireLock(cwd: string): LockResult {
	ensureDir(cwd);
	const lockFile = paths(cwd).lock;
	try {
		const fd = fs.openSync(lockFile, "wx");
		fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
		fs.closeSync(fd);
		return { ok: true };
	} catch (e: any) {
		if (e?.code !== "EEXIST") return { ok: false, reason: `lock error: ${e?.message ?? e}` };
		try {
			const info = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number; at?: string };
			if (info.pid && !pidAlive(info.pid)) {
				fs.unlinkSync(lockFile);
				return acquireLock(cwd);
			}
			return {
				ok: false,
				reason: `another pi session holds .ouroboros/.lock (pid=${info.pid ?? "?"}, at=${info.at ?? "?"}). Close that session or delete the lock if stale.`,
			};
		} catch {
			return { ok: false, reason: "another pi session holds .ouroboros/.lock (unreadable)." };
		}
	}
}

function releaseLock(cwd: string): void {
	try {
		fs.unlinkSync(paths(cwd).lock);
	} catch {}
}

function loadState(cwd: string): State {
	try {
		const raw = fs.readFileSync(paths(cwd).state, "utf8");
		return { ...emptyState(), ...JSON.parse(raw) };
	} catch {
		return emptyState();
	}
}

function saveState(cwd: string, s: State): void {
	ensureDir(cwd);
	fs.writeFileSync(paths(cwd).state, JSON.stringify(s, null, 2));
}

function loadSeed(cwd: string): Seed | null {
	try {
		return JSON.parse(fs.readFileSync(paths(cwd).seedJson, "utf8")) as Seed;
	} catch {
		return null;
	}
}

function saveSeed(cwd: string, seed: Seed): void {
	ensureDir(cwd);
	fs.writeFileSync(paths(cwd).seedJson, JSON.stringify(seed, null, 2));
	fs.writeFileSync(paths(cwd).seedYaml, serializeSeedYaml(seed));
}

function appendInterview(cwd: string, entry: object): void {
	ensureDir(cwd);
	fs.appendFileSync(paths(cwd).interview, JSON.stringify(entry) + "\n");
}

// Local-only telemetry: ambiguity samples and ralph convergence events.
// Always appends to .ouroboros/telemetry.jsonl in the project; never sends
// data anywhere else.
function appendTelemetry(cwd: string, entry: object): void {
	try {
		ensureDir(cwd);
		fs.appendFileSync(
			paths(cwd).telemetry,
			JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
		);
	} catch {
		// Telemetry must never break a session.
	}
}

// ─────────────────────────────────────────────── minimal YAML serializer ──
// Hand-rolled because the seed shape is fixed and we want zero npm deps.

function yamlScalar(v: string): string {
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function yamlKey(k: string): string {
	return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : yamlScalar(k);
}

function serializeSeedYaml(s: Seed): string {
	const out: string[] = [];
	out.push("# Ouroboros Seed — immutable specification");
	out.push(`created_at: ${yamlScalar(s.created_at)}`);
	out.push(`locked: ${s.locked}`);
	out.push(`ambiguity: ${s.ambiguity}`);
	out.push(`goal: ${yamlScalar(s.goal)}`);
	out.push("acceptance_criteria:");
	for (const a of s.acceptance_criteria) out.push(`  - ${yamlScalar(a)}`);
	out.push("constraints:");
	for (const c of s.constraints) out.push(`  - ${yamlScalar(c)}`);
	out.push("ontology:");
	for (const [k, v] of Object.entries(s.ontology)) out.push(`  ${yamlKey(k)}: ${yamlScalar(v)}`);
	out.push("assumptions_exposed:");
	for (const a of s.assumptions_exposed) out.push(`  - ${yamlScalar(a)}`);
	return out.join("\n") + "\n";
}

// ───────────────────────────────────────────────── mechanical evaluation ──

interface MechResult {
	skipped: boolean;
	command?: string;
	exitCode?: number;
	tail?: string;
	reason?: string;
}

function detectMechanical(cwd: string): { cmd: string; args: string[] } | null {
	const has = (p: string) => fs.existsSync(path.join(cwd, p));
	if (has("package.json")) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
			if (pkg?.scripts?.test) return { cmd: "npm", args: ["test", "--silent"] };
		} catch {
			// fallthrough
		}
	}
	if (has("pyproject.toml") || has("pytest.ini")) return { cmd: "pytest", args: ["-q"] };
	if (has("Makefile")) {
		try {
			const mk = fs.readFileSync(path.join(cwd, "Makefile"), "utf8");
			if (/^test\s*:/m.test(mk)) return { cmd: "make", args: ["test"] };
		} catch {
			// fallthrough
		}
	}
	if (has("Cargo.toml")) return { cmd: "cargo", args: ["test", "--quiet"] };
	if (has("go.mod")) return { cmd: "go", args: ["test", "./..."] };
	return null;
}

async function runMechanical(cwd: string, signal?: AbortSignal): Promise<MechResult> {
	const detected = detectMechanical(cwd);
	if (!detected) return { skipped: true, reason: "no recognized test runner" };
	return new Promise((resolve) => {
		const child = spawn(detected.cmd, detected.args, { cwd, signal });
		let buf = "";
		const onChunk = (b: Buffer) => {
			buf += b.toString();
			if (buf.length > 64 * 1024) buf = buf.slice(-64 * 1024);
		};
		child.stdout.on("data", onChunk);
		child.stderr.on("data", onChunk);
		child.on("error", (err) =>
			resolve({
				skipped: false,
				command: `${detected.cmd} ${detected.args.join(" ")}`,
				exitCode: -1,
				tail: String(err),
			}),
		);
		child.on("close", (code) =>
			resolve({
				skipped: false,
				command: `${detected.cmd} ${detected.args.join(" ")}`,
				exitCode: code ?? -1,
				tail: buf.trim().split("\n").slice(-50).join("\n"),
			}),
		);
	});
}

// ─────────────────────────────────────────────────── system-prompt block ──

// Karpathy coding harness — applied whenever this extension is loaded.
// Source: https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md
const KARPATHY_HARNESS = `## Coding harness (Karpathy guidelines)

1. **Think Before Coding** — Don't assume. Don't hide confusion. Surface tradeoffs.
   - State assumptions explicitly. If uncertain, ask.
   - If multiple interpretations exist, present them — don't pick silently.
   - If a simpler approach exists, say so. Push back when warranted.
   - If something is unclear, stop. Name what's confusing. Ask.

2. **Simplicity First** — Minimum code that solves the problem. Nothing speculative.
   - No features beyond what was asked.
   - No abstractions for single-use code.
   - No flexibility/configurability that wasn't requested.
   - No error handling for impossible scenarios.
   - If you wrote 200 lines and it could be 50, rewrite it.

3. **Surgical Changes** — Touch only what you must. Clean up only your own mess.
   - Don't "improve" adjacent code, comments, or formatting.
   - Don't refactor things that aren't broken.
   - Match existing style, even if you'd do it differently.
   - Mention unrelated dead code — don't delete it.
   - Remove orphans your changes created; don't remove pre-existing dead code.
   - Test: every changed line traces directly to the user's request.

4. **Goal-Driven Execution** — Define success criteria. Loop until verified.
   - "Add validation" → "Write tests for invalid inputs, then make them pass."
   - "Fix the bug" → "Write a test that reproduces it, then make it pass."
   - "Refactor X" → "Ensure tests pass before and after."
   - For multi-step tasks, state a brief plan with verify steps.`;

function buildOuroborosPromptBlock(state: State, seed: Seed | null): string {
	// Karpathy harness only activates once a seed is locked — pre-spec sessions
	// stay un-augmented so users can scaffold/explore freely.
	const out: string[] = seed?.locked ? [KARPATHY_HARNESS] : [];

	if (state.interview?.active) {
		out.push("## Ouroboros Interview (active)");
		out.push(`Goal under interview: ${state.interview.goal}`);
		out.push(`Turns so far: ${state.interview.turns}`);
		out.push(
			"Run a Socratic interview. ASK ONE QUESTION at a time. Each question must target a hidden assumption, ambiguity, or boundary the user has not yet pinned down. Cover (in roughly this order across turns): ontology terms, acceptance criteria, hard constraints, anti-cases, edge cases, success metrics, and out-of-scope items.",
		);
		out.push(
			"After each user answer, call `ooo_seed_set` to record what you've learned (add ACs, define ontology terms, list constraints, note exposed assumptions). Update the running ambiguity score (0 = perfectly specified, 1 = total fog).",
		);
		out.push(
			"Even when ambiguity ≤ 0.2 and ≥ 5 ACs are recorded, do NOT call `ooo_seed_finalize` yet if you still have material questions in mind — load-bearing assumptions, untested edge cases, unresolved ontology gaps, or unconfirmed anti-cases. Keep interviewing until you have no more material questions, THEN call `ooo_seed_finalize` to lock the seed. The metric thresholds are necessary but not sufficient. Do not write any production code during the interview.",
		);
	}

	if (seed?.locked) {
		out.push("## Ouroboros Seed (locked, authoritative)");
		out.push(`Goal: ${seed.goal}`);
		out.push("Acceptance criteria:");
		seed.acceptance_criteria.forEach((a, i) => out.push(`  ${i + 1}. ${a}`));
		if (seed.constraints.length) {
			out.push("Constraints:");
			seed.constraints.forEach((c) => out.push(`  • ${c}`));
		}
		if (Object.keys(seed.ontology).length) {
			out.push("Ontology:");
			for (const [k, v] of Object.entries(seed.ontology)) out.push(`  ${k} := ${v}`);
		}
		out.push(
			"All work in this session must serve the seed. If you discover the seed is wrong, STOP and report — do not silently re-scope.",
		);
	}

	if (state.persona && state.personaTurnsLeft > 0) {
		const p = PERSONAS[state.persona];
		out.push(`## Lateral persona: ${p.label} (${state.personaTurnsLeft} turn(s) left)`);
		out.push(p.prompt);
	}

	if (state.ralph?.active) {
		out.push("## Ralph loop (active)");
		out.push(
			`After completing this turn's work, you will be auto-prompted to run \`/ooo-evaluate\`. If any AC is failing, continue. When all ACs pass, output the literal token CONVERGED and call \`/ooo-ralph off\` to stop. Hard cap: ${state.ralph.cap} turns; current turn ${state.ralph.turn}.`,
		);
	}

	return out.length ? "\n\n" + out.join("\n") + "\n" : "";
}

// ─────────────────────────────────────────────────────────── helpers ──

function seedDraftAmbiguityHint(d: Partial<Seed> | null): number {
	if (!d) return 1.0;
	const pieces = [
		d.goal ? 0 : 0.3,
		(d.acceptance_criteria?.length ?? 0) >= 5 ? 0 : 0.25,
		(d.constraints?.length ?? 0) >= 1 ? 0 : 0.15,
		Object.keys(d.ontology ?? {}).length >= 2 ? 0 : 0.15,
		(d.assumptions_exposed?.length ?? 0) >= 3 ? 0 : 0.15,
	];
	return Math.max(0, Math.min(1, pieces.reduce((a, b) => a + b, 0)));
}

function fence(text: string): string {
	return "```\n" + text + "\n```";
}

// ────────────────────────────────────────────────────────── main export ──

export default function (pi: ExtensionAPI): void {
	let cwd = process.cwd();
	let state: State = emptyState();
	let seed: Seed | null = null;

	const persist = () => saveState(cwd, state);

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd ?? process.cwd();
		const lock = acquireLock(cwd);
		if (!lock.ok) {
			const msg = `Ouroboros lock denied: ${lock.reason}`;
			ctx.ui.notify(msg, "error");
			throw new Error(msg);
		}
		state = loadState(cwd);
		seed = loadSeed(cwd);
		const bits: string[] = [];
		if (seed?.locked) bits.push(`seed locked (${seed.acceptance_criteria.length} ACs)`);
		if (state.interview?.active) bits.push("interview active");
		if (state.persona) bits.push(`persona=${state.persona}`);
		if (state.ralph?.active) bits.push(`ralph ${state.ralph.turn}/${state.ralph.cap}`);
		ctx.ui.notify(`Ouroboros ready${bits.length ? ": " + bits.join(", ") : ""}`, "info");
	});

	pi.on("session_shutdown", async () => {
		releaseLock(cwd);
	});

	// Hard evaluate gate: refuse mutating tools until a seed is locked.
	const MUTATING_TOOLS = new Set(["edit", "write", "notebook_edit"]);
	pi.on("tool_call", async (event, _ctx) => {
		if (seed?.locked) return;
		if (!MUTATING_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason:
				"Ouroboros gate: no locked seed in .ouroboros/seed.json. Run `/ooo-interview <goal>` first, finalize the seed (ambiguity ≤ 0.2 and ≥ 5 ACs), then retry. Mutating tools are blocked until specs are locked.",
		};
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const block = buildOuroborosPromptBlock(state, seed);
		if (!block) return;
		return { systemPrompt: event.systemPrompt + block };
	});

	pi.on("agent_end", async (_event, _ctx) => {
		// Decrement persona budget once per turn.
		if (state.persona && state.personaTurnsLeft > 0) {
			state.personaTurnsLeft -= 1;
			if (state.personaTurnsLeft === 0) state.persona = null;
			persist();
		}

		// Tally interview turns.
		if (state.interview?.active) {
			state.interview.turns += 1;
			persist();
		}

		// Ralph auto follow-up.
		if (state.ralph?.active) {
			state.ralph.turn += 1;
			appendTelemetry(cwd, { kind: "ralph_turn", turn: state.ralph.turn, cap: state.ralph.cap });
			if (state.ralph.turn >= state.ralph.cap) {
				state.ralph.active = false;
				persist();
				appendTelemetry(cwd, { kind: "ralph_capped", turn: state.ralph.turn, cap: state.ralph.cap });
				await pi.sendUserMessage(
					`Ralph hit the ${state.ralph.cap}-turn cap without converging. Stopping. Inspect \`.ouroboros/state.json\` and the AC grades, then decide whether to revise the seed or restart with a higher cap.`,
				);
				return;
			}
			persist();
			await pi.sendUserMessage(
				"Ralph step: run `/ooo-evaluate` now. If any AC is failing, fix the smallest delta needed and continue working. If all ACs pass, output the literal token CONVERGED and run `/ooo-ralph off`.",
				{ deliverAs: "followUp" },
			);
		}
	});

	// ─────────────────────────────────────────────────── tools (LLM-callable) ──

	pi.registerTool(
		defineTool({
			name: "ooo_seed_set",
			label: "Seed.set",
			description:
				"Update the in-progress Ouroboros seed draft during an interview. Merge-style: provided fields overwrite/extend, unspecified fields stay.",
			promptSnippet: "ooo_seed_set: record interview learnings into the draft seed.",
			parameters: Type.Object({
				goal: Type.Optional(Type.String()),
				add_acceptance_criteria: Type.Optional(Type.Array(Type.String())),
				add_constraints: Type.Optional(Type.Array(Type.String())),
				ontology: Type.Optional(
					Type.Array(
						Type.Object({ term: Type.String(), definition: Type.String() }),
					),
				),
				add_assumptions_exposed: Type.Optional(Type.Array(Type.String())),
				ambiguity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			}),
			async execute(_id, params) {
				const d: Partial<Seed> = state.seedDraft ?? {
					acceptance_criteria: [],
					constraints: [],
					ontology: {},
					assumptions_exposed: [],
				};
				if (params.goal) d.goal = params.goal;
				if (params.add_acceptance_criteria)
					d.acceptance_criteria = [
						...(d.acceptance_criteria ?? []),
						...params.add_acceptance_criteria,
					];
				if (params.add_constraints)
					d.constraints = [...(d.constraints ?? []), ...params.add_constraints];
				if (params.ontology) {
					d.ontology = { ...(d.ontology ?? {}) };
					for (const e of params.ontology) d.ontology[e.term] = e.definition;
				}
				if (params.add_assumptions_exposed)
					d.assumptions_exposed = [
						...(d.assumptions_exposed ?? []),
						...params.add_assumptions_exposed,
					];
				if (typeof params.ambiguity === "number") {
					d.ambiguity = params.ambiguity;
					appendTelemetry(cwd, { kind: "ambiguity", value: params.ambiguity });
				}
				state.seedDraft = d;
				persist();
				appendInterview(cwd, { kind: "seed_set", at: new Date().toISOString(), patch: params });
				const inferred = seedDraftAmbiguityHint(d);
				return {
					content: [
						{
							type: "text",
							text: `Draft updated. ACs=${d.acceptance_criteria?.length ?? 0}, constraints=${d.constraints?.length ?? 0}, ontology=${Object.keys(d.ontology ?? {}).length}. Reported ambiguity=${d.ambiguity ?? "?"}, structure-based hint=${inferred.toFixed(2)}.`,
						},
					],
					details: {
						draft: d,
						inferredAmbiguity: inferred,
					},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ooo_seed_finalize",
			label: "Seed.finalize",
			description:
				"Lock the current seed draft into an immutable seed.yaml. Call only when (a) ambiguity ≤ 0.2, (b) at least 5 ACs are present, AND (c) you have no more material questions to ask. The metric thresholds gate eligibility, but a lingering material question (load-bearing assumption, edge case, ontology gap, anti-case) means keep interviewing — do not finalize prematurely.",
			promptSnippet: "ooo_seed_finalize: lock the seed and end the interview.",
			parameters: Type.Object({
				ambiguity: Type.Number({ minimum: 0, maximum: 1 }),
			}),
			async execute(_id, params) {
				const d = state.seedDraft;
				if (!d?.goal) throw new Error("seed draft has no goal — call ooo_seed_set first");
				if ((d.acceptance_criteria?.length ?? 0) < 5)
					throw new Error("seed draft needs ≥ 5 acceptance criteria");
				if (params.ambiguity > 0.2)
					throw new Error(`ambiguity ${params.ambiguity} > 0.2 — keep interviewing`);
				const finalSeed: Seed = {
					goal: d.goal,
					acceptance_criteria: d.acceptance_criteria ?? [],
					constraints: d.constraints ?? [],
					ontology: d.ontology ?? {},
					assumptions_exposed: d.assumptions_exposed ?? [],
					ambiguity: params.ambiguity,
					created_at: new Date().toISOString(),
					locked: true,
				};
				saveSeed(cwd, finalSeed);
				seed = finalSeed;
				state.interview = null;
				state.seedDraft = null;
				persist();
				appendInterview(cwd, { kind: "finalize", at: finalSeed.created_at });
				appendTelemetry(cwd, { kind: "ambiguity", value: finalSeed.ambiguity, finalize: true });
				return {
					content: [
						{
							type: "text",
							text: `Seed LOCKED at ${finalSeed.created_at}. ${finalSeed.acceptance_criteria.length} ACs, ${finalSeed.constraints.length} constraints, ${Object.keys(finalSeed.ontology).length} ontology terms, ambiguity=${finalSeed.ambiguity}. Written to .ouroboros/seed.yaml. Interview is now closed.`,
						},
					],
					details: { seed: finalSeed },
					terminate: true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ooo_grade_ac",
			label: "AC.grade",
			description:
				"Record a verdict on one acceptance criterion of the locked seed. Used during /ooo-evaluate.",
			promptSnippet: "ooo_grade_ac: record verdict on a single AC during evaluation.",
			parameters: Type.Object({
				index: Type.Integer({ minimum: 1 }),
				verdict: StringEnum(["pass", "fail", "n/a"] as const),
				evidence: Type.String({
					description:
						"Brief evidence: file paths, test names, or a one-line justification.",
				}),
			}),
			async execute(_id, params) {
				if (!seed?.locked) throw new Error("no locked seed — run /ooo-interview first");
				const ac = seed.acceptance_criteria[params.index - 1];
				if (!ac) throw new Error(`AC index ${params.index} out of range`);
				state.acGrades = state.acGrades.filter((g) => g.index !== params.index);
				state.acGrades.push({
					index: params.index,
					criterion: ac,
					verdict: params.verdict,
					evidence: params.evidence,
					at: new Date().toISOString(),
				});
				persist();
				const totals = tallyGrades(state.acGrades, seed.acceptance_criteria.length);
				return {
					content: [
						{
							type: "text",
							text: `Recorded AC ${params.index}: ${params.verdict}. Tally: ${totals.pass} pass / ${totals.fail} fail / ${totals.na} n-a / ${totals.ungraded} ungraded.`,
						},
					],
					details: { totals },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ooo_record_drift",
			label: "Drift.record",
			description:
				"Record self-assessed drift vs the locked seed. Components in [0,1]: 0 = perfectly aligned, 1 = totally drifted.",
			promptSnippet:
				"ooo_record_drift: log goal/constraint/ontology drift vs the locked seed.",
			parameters: Type.Object({
				goal: Type.Number({ minimum: 0, maximum: 1 }),
				constraint: Type.Number({ minimum: 0, maximum: 1 }),
				ontology: Type.Number({ minimum: 0, maximum: 1 }),
				notes: Type.String(),
			}),
			async execute(_id, params) {
				if (!seed?.locked) throw new Error("no locked seed — drift is undefined");
				const weighted = 0.5 * params.goal + 0.3 * params.constraint + 0.2 * params.ontology;
				state.drift = {
					goal: params.goal,
					constraint: params.constraint,
					ontology: params.ontology,
					weighted,
					notes: params.notes,
					at: new Date().toISOString(),
				};
				persist();
				const verdict = weighted <= 0.3 ? "OK" : "DRIFTED";
				return {
					content: [
						{
							type: "text",
							text: `Drift weighted=${weighted.toFixed(3)} (${verdict}). g=${params.goal} c=${params.constraint} o=${params.ontology}. Threshold = 0.30.`,
						},
					],
					details: state.drift,
				};
			},
		}),
	);

	// ─────────────────────────────────────────────────────────── commands ──

	pi.registerCommand("ooo-interview", {
		description: "Start an Ouroboros Socratic interview for the given goal",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("usage: /ooo-interview <goal>", "warning");
				return;
			}
			if (seed?.locked) {
				const ok = await ctx.ui.confirm(
					"Seed already locked",
					"Re-running the interview will create a new draft. The existing seed.yaml remains. Continue?",
				);
				if (!ok) return;
			}
			state.interview = { active: true, turns: 0, goal };
			state.seedDraft = {
				goal,
				acceptance_criteria: [],
				constraints: [],
				ontology: {},
				assumptions_exposed: [],
				ambiguity: 1.0,
			};
			persist();
			appendInterview(cwd, { kind: "start", at: new Date().toISOString(), goal });
			ctx.ui.notify(`Interview started: ${goal}`, "info");
			await pi.sendUserMessage(
				`Begin the Ouroboros interview for the goal: "${goal}".\n\nAsk ONE Socratic question that exposes the most load-bearing hidden assumption you can identify. After my answer, call \`ooo_seed_set\` to record the learning, then ask the next question. Continue until you have no more material questions AND ambiguity ≤ 0.2 AND ≥ 5 acceptance criteria are pinned — only then call \`ooo_seed_finalize\`. The thresholds are necessary but not sufficient: if questions remain in your head, keep asking.`,
			);
		},
	});

	pi.registerCommand("ooo-seed", {
		description: "Show the current seed (or draft, if interviewing)",
		handler: async (_args, ctx) => {
			if (seed?.locked) {
				ctx.ui.notify(
					`seed locked: ${seed.acceptance_criteria.length} ACs, ambiguity=${seed.ambiguity}`,
					"info",
				);
				await pi.sendUserMessage(
					`Current locked seed:\n\n${fence(serializeSeedYaml(seed))}`,
				);
				return;
			}
			if (state.seedDraft) {
				ctx.ui.notify("draft only — not yet locked", "info");
				await pi.sendUserMessage(
					`Current seed draft (NOT locked):\n\n${fence(JSON.stringify(state.seedDraft, null, 2))}`,
				);
				return;
			}
			ctx.ui.notify("no seed yet — run /ooo-interview <goal>", "warning");
		},
	});

	pi.registerCommand("ooo-evaluate", {
		description: "Run the 3-stage evaluation gate (mechanical + semantic AC grading)",
		handler: async (_args, ctx) => {
			if (!seed?.locked) {
				ctx.ui.notify("no locked seed — run /ooo-interview first", "warning");
				return;
			}
			ctx.ui.setStatus("ouroboros", "evaluate: mechanical...");
			const mech = await runMechanical(cwd);
			ctx.ui.setStatus("ouroboros", undefined);
			state.acGrades = [];
			persist();
			const mechBlock = mech.skipped
				? `Mechanical: SKIPPED (${mech.reason})`
				: `Mechanical: \`${mech.command}\` → exit ${mech.exitCode}\n${fence(mech.tail ?? "")}`;
			const acList = seed.acceptance_criteria.map((a, i) => `${i + 1}. ${a}`).join("\n");
			await pi.sendUserMessage(
				`# Ouroboros evaluation\n\n${mechBlock}\n\n## Semantic stage\n\nGrade each acceptance criterion against the current state of the codebase. For each AC below, call \`ooo_grade_ac\` with index, verdict (pass | fail | n/a), and one-line evidence (file path, test name, or reason). Then summarize the totals.\n\n${acList}`,
			);
		},
	});

	pi.registerCommand("ooo-drift", {
		description: "Ask the agent to self-report drift (goal/constraint/ontology) vs the seed",
		handler: async (_args, ctx) => {
			if (!seed?.locked) {
				ctx.ui.notify("no locked seed — drift is undefined", "warning");
				return;
			}
			await pi.sendUserMessage(
				`Estimate Ouroboros drift vs the locked seed. Score each component in [0, 1] (0 = perfectly aligned, 1 = totally drifted) and call \`ooo_record_drift\`:\n\n  • goal       — has the work strayed from the goal? (weight 0.5)\n  • constraint — are any locked constraints violated? (weight 0.3)\n  • ontology   — are any defined terms being used inconsistently? (weight 0.2)\n\nThreshold for OK: weighted ≤ 0.30. Be honest; over-report rather than under-report.`,
			);
		},
	});

	pi.registerCommand("ooo-unstuck", {
		description: "Switch into a lateral-thinking persona for the next 3 turns",
		getArgumentCompletions: (prefix) => {
			const items = PERSONA_IDS.map((id) => ({
				value: id,
				label: `${id} — ${PERSONAS[id].label}`,
			}));
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			let id: PersonaId | null = null;
			const trimmed = args.trim();
			if (trimmed && (PERSONA_IDS as string[]).includes(trimmed)) {
				id = trimmed as PersonaId;
			} else {
				const choice = await ctx.ui.select(
					"Pick a lateral persona:",
					PERSONA_IDS.map((p) => `${p} — ${PERSONAS[p].label}`),
				);
				if (!choice) return;
				const picked = PERSONA_IDS.find((p) => choice.startsWith(`${p} `));
				id = picked ?? null;
			}
			if (!id) return;
			state.persona = id;
			state.personaTurnsLeft = 3;
			persist();
			ctx.ui.notify(`Persona: ${PERSONAS[id].label} (3 turns)`, "info");
			await pi.sendUserMessage(
				`Lateral persona engaged: **${PERSONAS[id].label}**.\n\n${PERSONAS[id].prompt}\n\nApply this lens to the current task. After 3 turns the persona auto-clears.`,
			);
		},
	});

	pi.registerCommand("ooo-ralph", {
		description: "Toggle the Ralph auto-evaluate-and-continue loop (on | off | <N> for cap)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off" || (state.ralph?.active && arg === "")) {
				const finalTurn = state.ralph?.turn ?? 0;
				const cap = state.ralph?.cap ?? 0;
				state.ralph = null;
				persist();
				appendTelemetry(cwd, {
					kind: "ralph_converged",
					turn: finalTurn,
					cap,
					reason: "manual_off",
				});
				ctx.ui.notify("ralph: off", "info");
				return;
			}
			const cap = /^\d+$/.test(arg) ? parseInt(arg, 10) : RALPH_DEFAULT_CAP;
			if (!seed?.locked) {
				ctx.ui.notify("no locked seed — ralph requires a seed", "warning");
				return;
			}
			state.ralph = { active: true, turn: 0, cap };
			persist();
			ctx.ui.notify(`ralph: on (cap ${cap})`, "info");
			await pi.sendUserMessage(
				`Ralph loop ON (cap ${cap}). After each turn I will auto-prompt you to run /ooo-evaluate and continue until all ACs pass (or the cap is hit). When all ACs pass, output the token CONVERGED and run /ooo-ralph off.`,
			);
		},
	});

	pi.registerCommand("ooo-status", {
		description: "Show interview / seed / persona / ralph / drift status",
		handler: async (_args, _ctx) => {
			const lines: string[] = [];
			lines.push(`seed: ${seed?.locked ? `locked (${seed.acceptance_criteria.length} ACs, ambiguity=${seed.ambiguity})` : "absent"}`);
			lines.push(
				`interview: ${state.interview?.active ? `active (${state.interview.turns} turns, goal="${state.interview.goal}")` : "idle"}`,
			);
			lines.push(
				`persona: ${state.persona ? `${state.persona} (${state.personaTurnsLeft} turns left)` : "—"}`,
			);
			lines.push(
				`ralph: ${state.ralph?.active ? `on (turn ${state.ralph.turn}/${state.ralph.cap})` : "off"}`,
			);
			if (seed?.locked) {
				const t = tallyGrades(state.acGrades, seed.acceptance_criteria.length);
				lines.push(
					`AC grades: ${t.pass} pass / ${t.fail} fail / ${t.na} n-a / ${t.ungraded} ungraded`,
				);
			}
			if (state.drift) {
				lines.push(
					`drift: weighted=${state.drift.weighted.toFixed(3)} (g=${state.drift.goal} c=${state.drift.constraint} o=${state.drift.ontology}) at ${state.drift.at}`,
				);
			}
			await pi.sendUserMessage(`# Ouroboros status\n\n${fence(lines.join("\n"))}`);
		},
	});

	pi.registerCommand("ooo-reset", {
		description:
			"Reset session-level state (interview, persona, ralph, AC grades). Does NOT delete the locked seed.",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm(
				"Reset Ouroboros state?",
				"Clears interview/draft/persona/ralph/AC-grades. seed.yaml is preserved.",
			);
			if (!ok) return;
			state = emptyState();
			persist();
			ctx.ui.notify("Ouroboros state reset", "info");
		},
	});

	// silence "unused" warning for ExtensionContext import
	void (null as unknown as ExtensionContext);
}

// ────────────────────────────────────────────────────────────── helpers ──

function tallyGrades(
	grades: ACGrade[],
	total: number,
): { pass: number; fail: number; na: number; ungraded: number } {
	let pass = 0;
	let fail = 0;
	let na = 0;
	for (const g of grades) {
		if (g.verdict === "pass") pass += 1;
		else if (g.verdict === "fail") fail += 1;
		else na += 1;
	}
	return { pass, fail, na, ungraded: Math.max(0, total - grades.length) };
}
