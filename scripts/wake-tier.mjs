#!/usr/bin/env node
// wake-tier.mjs — decide whether a silent agent is hung, and wake it at most twice.
//
// The watchdog answers "which running agents look stale?" and stops there:
// `confidence: "suspected"` on a single metadata timestamp, and an explicit
// `observation-only` action string. Nobody acts on it, so a hung agent sits
// until a human happens to open it. This module closes that gap WITHOUT
// turning the watchdog into an actuator.
//
// Two properties carry the design:
//
//   1. Signal-first, never single-signal. `UpdatedAt` going stale is one
//      signal and it is not enough — a long-running tool call looks identical
//      to a hang. A wake requires a SECOND, independent signal: the agent's
//      activity tail must be byte-identical across two probes separated by
//      `probeGapMs`. Metadata and the activity stream are produced by
//      different paths; agreeing is evidence, one of them alone is not.
//      Missing the second signal yields `cannot-verify`, never a wake.
//
//   2. A permission prompt is not a hang. `PendingPermissions` is checked
//      BEFORE staleness because a blocked agent presents exactly like a hung
//      one and waking it does nothing at all — the remedy is a human
//      answering the prompt. That branch escalates and never wakes.
//
// The ladder terminates. After `maxAttempts` wakes an agent stops being a
// wake candidate forever and becomes `escalate-to-human`: an agent that does
// not answer two probes is not going to answer the third, and a watchdog that
// re-prompts a dead agent every five minutes is a worse failure than silence.
//
// KNOWN FALSE POSITIVE, stated rather than papered over. The two signals are
// produced by different paths but they are not independent of the same cause:
// an agent inside ONE long tool call — a 20-minute test suite — has a frozen
// timestamp and a frozen activity tail for exactly the same reason. Both agree,
// and the classifier says wake-candidate about an agent that is working.
// Measured live 2026-08-31 by forcing hungAfterMs to 1s: two healthy agents
// classified as wake-candidate.
//
// Three things bound the cost rather than eliminate it. `hungAfterMs` defaults
// to 10 minutes, so the tool call has to outlast a threshold set above the
// project's own FULL_TEST. The wake prompt asks for a status line and forbids
// starting work, so the worst case is one ignorable message in the queue, not a
// derailed task. And the ladder stops at two. Raise `--hung-after-ms` above
// your longest sanctioned command; do not lower it to make the scan livelier.
//
// Closing this properly needs a signal that distinguishes "no events" from
// "one event still open" — a tool-call-in-flight flag the daemon does not
// currently expose. Recorded as an upstream ask, not worked around here: a
// guess dressed as a third signal would be worse than a stated limit.
//
// Separation of powers: classification and planning are pure and run anywhere;
// `wakeAgents()` is the only thing that mutates, it accepts ONLY ids the plan
// it was handed put in `wake`, and the CLI performs it exclusively under an
// explicit `--wake`. Reading is the default. That keeps `watchdog.mjs`
// observation-only (A5) and keeps the actuator in one auditable place.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isEntrypoint, resolvePaseoExec } from "./lib-common.mjs";
import { collectWatchdogSnapshot } from "./watchdog.mjs";

/**
 * Closed disposition vocabulary. Exactly one applies per agent, and the order
 * in `classifyWake` is the precedence order — see the ladder there.
 */
export const WAKE_DISPOSITIONS = Object.freeze([
	"healthy",
	"blocked-on-permission",
	"wake-candidate",
	"escalate-to-human",
	"gone",
	"cannot-verify",
]);

/** Dispositions that need somebody — a wake, or a human. Drive the exit code. */
export const ACTIONABLE_DISPOSITIONS = Object.freeze([
	"wake-candidate",
	"escalate-to-human",
	"blocked-on-permission",
	"gone",
]);

export const DEFAULT_HUNG_AFTER_MS = 10 * 60_000;
export const DEFAULT_PROBE_GAP_MS = 20_000;
export const DEFAULT_MAX_WAKES = 3;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_ACTIVITY_TAIL = 20;

export const WAKE_TIER_ERROR_CODES = Object.freeze(["USAGE", "STATE_UNREADABLE", "WAKE_FAILED"]);

/**
 * The prompt a wake sends. It deliberately asks for a status line and forbids
 * new work: a woken agent's authority still comes from its current V3 brief,
 * and a wake that reads as a task turns the watchdog into an unbriefed
 * dispatcher.
 */
export function wakePrompt({ attempt, maxAttempts, idleMinutes }) {
	return [
		`[wake-tier probe ${attempt}/${maxAttempts}]`,
		`No recorded activity for ${idleMinutes}m and your activity tail did not move between two probes.`,
		"Reply with your current step if you are still working, or BLOCKED plus the reason if you are stuck.",
		"Do not start new work from this message: your authority is still only the current task brief.",
	].join(" ");
}

/**
 * Stable digest of an activity tail. Content, not length: an agent emitting
 * the same spinner frame forever must not read as progress.
 */
export function activityDigest(text) {
	if (typeof text !== "string") return null;
	return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

/**
 * The ladder. Pure over one evidence record; every branch below is reachable
 * from `test/wake-tier.test.mjs`.
 *
 * evidence: { status, inspectOk, ageMs, pendingPermissions, activityA,
 *             activityB, wakeAttempts }
 */
export function classifyWake(evidence = {}, options = {}) {
	const hungAfterMs = Math.max(1000, options.hungAfterMs ?? DEFAULT_HUNG_AFTER_MS);
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));

	if (evidence.status !== "running") {
		return { disposition: "gone", reason: `status is ${String(evidence.status ?? "unknown")}, not running` };
	}
	if (evidence.inspectOk !== true) {
		return { disposition: "cannot-verify", reason: "inspect did not succeed; status is not trustworthy" };
	}
	// Before staleness on purpose: a permission prompt produces the same
	// silence as a hang, and a wake is the wrong remedy for it.
	const pending = Array.isArray(evidence.pendingPermissions) ? evidence.pendingPermissions : [];
	if (pending.length > 0) {
		return {
			disposition: "blocked-on-permission",
			reason: `${pending.length} pending permission(s); a human must answer, waking does nothing`,
		};
	}
	if (!Number.isFinite(evidence.ageMs)) {
		return { disposition: "cannot-verify", reason: "no usable updatedAt timestamp" };
	}
	if (evidence.ageMs < hungAfterMs) {
		return { disposition: "healthy", reason: `active ${Math.round(evidence.ageMs / 1000)}s ago` };
	}
	// Signal 2. Absent means unverified, and unverified never wakes.
	if (typeof evidence.activityA !== "string" || typeof evidence.activityB !== "string") {
		return {
			disposition: "cannot-verify",
			reason: "stale timestamp but the activity tail could not be probed twice; one signal never wakes",
		};
	}
	if (evidence.activityA !== evidence.activityB) {
		return {
			disposition: "healthy",
			reason: "activity tail moved between probes; the stale timestamp is the weaker signal and loses",
		};
	}
	const attempts = Math.max(0, Math.floor(evidence.wakeAttempts ?? 0));
	if (attempts >= maxAttempts) {
		return {
			disposition: "escalate-to-human",
			reason: `already woken ${attempts}/${maxAttempts} times with no response; the ladder ends here`,
		};
	}
	return {
		disposition: "wake-candidate",
		reason: `idle ${Math.round(evidence.ageMs / 60_000)}m, activity tail unchanged across two probes`,
		attempt: attempts + 1,
	};
}

/**
 * Turn classified evidence into a plan.
 *
 * `blind` is the P5 inversion this pack already applies elsewhere: running
 * agents exist but not one could be classified. That is a broken observer, not
 * a healthy fleet, so it is actionable rather than a green run.
 *
 * Over-cap candidates land in `deferred` with a stated reason. A silently
 * truncated wake list reads as "everything handled" when it was not.
 */
export function planWake(evidences = [], options = {}) {
	const maxWakes = Math.max(1, Math.floor(options.maxWakes ?? DEFAULT_MAX_WAKES));
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
	const hungAfterMs = Math.max(1000, options.hungAfterMs ?? DEFAULT_HUNG_AFTER_MS);

	const items = evidences.map((evidence) => ({
		id: evidence.id,
		shortId: evidence.shortId ?? evidence.id,
		provider: evidence.provider ?? null,
		cwd: evidence.cwd ?? null,
		ageMs: Number.isFinite(evidence.ageMs) ? evidence.ageMs : null,
		wakeAttempts: Math.max(0, Math.floor(evidence.wakeAttempts ?? 0)),
		...classifyWake(evidence, { hungAfterMs, maxAttempts }),
	}));

	const counts = Object.fromEntries(WAKE_DISPOSITIONS.map((d) => [d, 0]));
	for (const item of items) counts[item.disposition] += 1;

	const candidates = items.filter((item) => item.disposition === "wake-candidate");
	const wake = candidates.slice(0, maxWakes).map((item) => ({
		id: item.id,
		attempt: item.attempt,
		prompt: wakePrompt({
			attempt: item.attempt,
			maxAttempts,
			idleMinutes: Math.round((item.ageMs ?? 0) / 60_000),
		}),
	}));
	const deferred = candidates.slice(maxWakes).map((item) => ({
		id: item.id,
		reason: `over the per-run wake cap (${maxWakes}); deferred to the next run, not dropped`,
	}));

	const running = items.length;
	const blind = running > 0 && items.every((item) => item.disposition === "cannot-verify");
	const actionable = items.some((item) => ACTIONABLE_DISPOSITIONS.includes(item.disposition));

	return {
		generatedAt: new Date(options.now ?? Date.now()).toISOString(),
		hungAfterMs,
		maxWakes,
		maxAttempts,
		items,
		counts,
		wake,
		deferred,
		blind,
		actionable,
	};
}

/**
 * The only mutating function in this module.
 *
 * Wakes exactly the ids the supplied plan put in `wake` — an id from anywhere
 * else throws rather than being sent. That is what makes "the classifier
 * authorised this wake" checkable instead of assumed.
 */
export async function wakeAgents(plan, options = {}) {
	const sendPrompt = options.sendPrompt;
	if (typeof sendPrompt !== "function") {
		throw Object.assign(new Error("wakeAgents requires options.sendPrompt"), { code: "USAGE" });
	}
	const authorised = new Set((plan?.wake ?? []).map((entry) => entry.id));
	const targets = options.only ?? (plan?.wake ?? []);
	const woke = [];
	const failed = [];
	for (const entry of targets) {
		if (!authorised.has(entry.id)) {
			throw Object.assign(
				new Error(`refusing to wake ${entry.id}: not in the plan this call was given`),
				{ code: "WAKE_FAILED" },
			);
		}
		try {
			await sendPrompt(entry.id, entry.prompt);
			woke.push({ id: entry.id, attempt: entry.attempt });
		} catch (error) {
			failed.push({ id: entry.id, error: String(error?.message ?? error) });
		}
	}
	return { woke, failed };
}

// ---------------------------------------------------------------------------
// State — the attempt counter that makes the ladder terminate.
// ---------------------------------------------------------------------------

export function wakeStatePath(stateDir = process.env.PASEO_TEAM_STATE_DIR) {
	return join(stateDir || join(process.env.HOME || ".", ".claude", "paseo-team", "state"), "wake-tier.json");
}

export function readWakeState(path) {
	if (!existsSync(path)) return { version: 1, agents: {} };
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw Object.assign(new Error(`wake state is unreadable: ${String(error?.message ?? error)}`), {
			code: "STATE_UNREADABLE",
		});
	}
	if (!parsed || typeof parsed !== "object" || typeof parsed.agents !== "object" || parsed.agents === null) {
		throw Object.assign(new Error("wake state is not a { version, agents } object"), { code: "STATE_UNREADABLE" });
	}
	return { version: 1, agents: parsed.agents };
}

/**
 * Record the run. An agent seen `healthy` has its counter cleared: the ladder
 * measures consecutive unanswered wakes, so a one-off slow turn months ago
 * must not push a genuinely stuck agent straight to escalation today.
 */
export function nextWakeState(state, plan, wokeIds = [], now = Date.now()) {
	const agents = { ...(state?.agents ?? {}) };
	for (const item of plan.items) {
		if (item.disposition === "healthy") delete agents[item.id];
	}
	for (const id of wokeIds) {
		const previous = agents[id]?.attempts ?? 0;
		agents[id] = { attempts: previous + 1, lastWakeAt: new Date(now).toISOString() };
	}
	return { version: 1, agents };
}

export function writeWakeState(path, state) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Evidence collection — the only part that talks to the daemon.
// ---------------------------------------------------------------------------

function paseoExec() {
	return resolvePaseoExec((reason) => {
		throw Object.assign(new Error(`PASEO_TEAM_PASEO_EXEC ${reason}`), { code: "PASEO_EXEC_INVALID" });
	});
}

/** `paseo logs` has no JSON mode, so the activity tail is read as text. */
export function runPaseoText(args, timeoutMs = 5000) {
	const [bin, ...prefix] = paseoExec();
	return new Promise((resolve, reject) => {
		execFile(
			bin,
			[...prefix, ...args],
			{ encoding: "utf8", timeout: timeoutMs, env: process.env, windowsHide: true },
			(error, stdout) => {
				if (error) {
					reject(Object.assign(new Error(String(error.message)), { code: error.code ?? "CLI_ERROR" }));
					return;
				}
				resolve(String(stdout ?? ""));
			},
		);
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One watchdog snapshot for signal 1, then two activity probes for signal 2 —
 * but only for the agents that actually reach the corroboration step. Probing
 * a healthy fleet twice would cost a `probeGapMs` wait for nothing.
 */
export async function collectWakeEvidence(options = {}) {
	const hungAfterMs = Math.max(1000, options.hungAfterMs ?? DEFAULT_HUNG_AFTER_MS);
	const probeGapMs = Math.max(0, options.probeGapMs ?? DEFAULT_PROBE_GAP_MS);
	const tail = Math.max(1, Math.floor(options.activityTail ?? DEFAULT_ACTIVITY_TAIL));
	const readActivity = options.readActivity ?? ((id) => runPaseoText(["logs", id, "--tail", String(tail)]));
	const wait = options.sleep ?? sleep;
	const attemptsById = options.attemptsById ?? {};

	const snapshot = options.snapshot ?? (await collectWatchdogSnapshot({ ...options, staleAfterMs: hungAfterMs }));
	const base = (snapshot.agents ?? []).map((agent) => ({
		id: agent.id,
		shortId: agent.shortId ?? agent.id,
		provider: agent.provider ?? null,
		cwd: agent.cwd ?? null,
		status: agent.status,
		inspectOk: agent.inspectOk === true,
		ageMs: Number.isFinite(agent.ageMs) ? agent.ageMs : null,
		pendingPermissions: agent.pendingPermissions ?? [],
		wakeAttempts: attemptsById[agent.id] ?? 0,
		activityA: null,
		activityB: null,
	}));

	// Reaches corroboration only if every earlier rung passed.
	const shortlist = base.filter(
		(evidence) =>
			evidence.status === "running" &&
			evidence.inspectOk &&
			(evidence.pendingPermissions?.length ?? 0) === 0 &&
			Number.isFinite(evidence.ageMs) &&
			evidence.ageMs >= hungAfterMs,
	);
	if (shortlist.length === 0) return { snapshot, evidences: base };

	const probe = async (key) => {
		for (const evidence of shortlist) {
			try {
				evidence[key] = activityDigest(await readActivity(evidence.id));
			} catch {
				evidence[key] = null; // stays cannot-verify; never a wake
			}
		}
	};
	await probe("activityA");
	await wait(probeGapMs);
	await probe("activityB");
	return { snapshot, evidences: base };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseWakeArgs(argv) {
	const options = { wake: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--wake") {
			options.wake = true;
			continue;
		}
		const numeric = {
			"--hung-after-ms": "hungAfterMs",
			"--probe-gap-ms": "probeGapMs",
			"--max-wakes": "maxWakes",
			"--max-attempts": "maxAttempts",
		}[arg];
		if (numeric) {
			const raw = argv[++i];
			const value = Number(raw);
			if (raw === undefined || !Number.isFinite(value)) {
				throw Object.assign(new Error(`${arg} requires a number`), { code: "USAGE" });
			}
			options[numeric] = value;
			continue;
		}
		throw Object.assign(new Error(`unknown argument: ${arg}`), { code: "USAGE" });
	}
	return options;
}

/** 0 nothing to do · 2 tool error · 3 somebody must act (or the scan is blind). */
export function exitCodeFor(plan) {
	return plan.actionable || plan.blind ? 3 : 0;
}

async function main(argv) {
	const options = parseWakeArgs(argv);
	const statePath = wakeStatePath();
	const state = readWakeState(statePath);
	const attemptsById = Object.fromEntries(
		Object.entries(state.agents).map(([id, record]) => [id, record?.attempts ?? 0]),
	);
	const { evidences } = await collectWakeEvidence({ ...options, attemptsById });
	const plan = planWake(evidences, options);

	let result = { woke: [], failed: [] };
	if (options.wake && plan.wake.length > 0) {
		result = await wakeAgents(plan, {
			sendPrompt: (id, prompt) => runPaseoText(["send", id, "--prompt", prompt, "--no-wait"], 20_000),
		});
	}
	writeWakeState(statePath, nextWakeState(state, plan, result.woke.map((entry) => entry.id)));

	console.log(JSON.stringify({ ...plan, applied: options.wake, ...result }, null, 2));
	return exitCodeFor(plan);
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
	return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(
				JSON.stringify({ ok: false, code: error?.code ?? "WAKE_TIER_FAILED", message: String(error?.message ?? error) }),
			);
			process.exitCode = 2;
		});
}
