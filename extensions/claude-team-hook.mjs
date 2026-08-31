#!/usr/bin/env node
/**
 * claude-team-hook.mjs — Claude Code hook binding for the Paseo team role pack.
 *
 * One executable serving four hook events, dispatching on hook_event_name read
 * from stdin. It is the Claude equivalent of the Pi extension's event wiring:
 *
 *   SessionStart      → reset per-session state
 *   UserPromptSubmit  → re-parse the V3 brief from THIS turn, persist it, and
 *                       inject the role contract   (≈ before_agent_start)
 *   PreToolUse        → allow/deny one tool call   (≈ tool_call)
 *   SessionEnd        → drop the state file
 *
 * Passive by default: with PASEO_CLAUDE_ROLE unset it exits 0 and emits
 * nothing, so a plain `claude` session on the same machine is untouched.
 *
 * Fail-closed: any error while deciding a tool call denies it, and a peer turn
 * whose state cannot be read resolves to read-only.
 *
 * Verified 2026-08-20 against Claude Code 2.1.237: a PreToolUse deny is honored
 * even under `--permission-mode bypassPermissions`, which is what makes this a
 * real bound rather than a suggestion.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeToolBlockReason } from "./claude-policy.mts";
import { HARNESS_ROLE_VALUES, parseTaskBrief, peerGitAuthority, resolvePeerMode } from "./policy-core.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
// Single vocabulary owner is policy-core (F015); no local copy to drift.
const ROLES = new Set(HARNESS_ROLE_VALUES);

function detectClaudeRole() {
	const raw = process.env.PASEO_CLAUDE_ROLE?.trim().toLowerCase();
	return ROLES.has(raw) ? raw : undefined;
}

function stateDir() {
	return (
		process.env.PASEO_TEAM_STATE_DIR?.trim() ||
		join(homedir(), ".claude", "paseo-team", "state")
	);
}

function statePath(sessionId) {
	const safe = String(sessionId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
	return join(stateDir(), `${safe}.json`);
}

function readState(sessionId) {
	try {
		return JSON.parse(readFileSync(statePath(sessionId), "utf8"));
	} catch {
		return null;
	}
}

function writeState(sessionId, state) {
	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(statePath(sessionId), JSON.stringify(state), { mode: 0o600 });
}

function clearState(sessionId) {
	try {
		rmSync(statePath(sessionId), { force: true });
	} catch {
		/* best effort */
	}
}

function promptsDir() {
	const override = process.env.PASEO_TEAM_PROMPTS_DIR?.trim();
	if (override) return override;
	const primary = join(HERE, "prompts");
	return existsSync(primary) ? primary : join(dirname(HERE), "prompts");
}

function loadPrompt(name) {
	try {
		return readFileSync(join(promptsDir(), `${name}.md`), "utf8");
	} catch {
		return "";
	}
}

/**
 * Rebuild the brief from the CURRENT prompt. Only peers carry authority, so
 * only peers parse; lead and supervisor authority is fixed by role.
 */
function briefFromPrompt(role, promptText) {
	if (role !== "peer") return null;
	return parseTaskBrief(String(promptText ?? ""));
}

function serializeBrief(brief) {
	if (!brief) return null;
	return {
		version: brief.version,
		mode: brief.mode,
		malformed: brief.malformed,
		fields: Object.fromEntries(brief.fields),
	};
}

function deserializeBrief(raw) {
	if (!raw || typeof raw !== "object") return null;
	return {
		version: raw.version,
		mode: raw.mode ?? null,
		malformed: Array.isArray(raw.malformed) ? raw.malformed : [],
		fields: new Map(Object.entries(raw.fields ?? {})),
	};
}

/**
 * The one directory the ask-lead / watchdog bash allowlist will accept. The
 * installed layout puts the support scripts next to the hook; an explicit
 * PASEO_TEAM_SCRIPTS_DIR wins. Matching on the filename alone would let a
 * write-mode Peer run its own copy, so the policy compares full paths.
 */
function scriptsDir() {
	const override = process.env.PASEO_TEAM_SCRIPTS_DIR?.trim();
	if (override) return override;
	const local = join(HERE, "scripts");
	return existsSync(local) ? local : join(dirname(HERE), "scripts");
}

function extraTools() {
	return (process.env.PASEO_TEAM_EXTRA_TOOLS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * The per-turn authority header. Short on purpose: the full role prompt goes in
 * once per session, but THIS block repeats every turn so a compaction that
 * drops earlier context cannot quietly widen the agent's self-understanding.
 */
function authorityHeader(role, brief) {
	const mode = resolvePeerMode(brief);
	const lines = [
		"## Paseo Team Role (current turn)",
		"",
		`ROLE: ${role}`,
	];
	if (role === "peer") {
		const git = peerGitAuthority(brief);
		lines.push(
			`MODE: ${mode}`,
			`TASK_ID: ${brief?.fields.get("TASK_ID") ?? "<none>"}`,
			`EDIT: ${git.edit ? "allowed" : "denied"} · COMMIT: ${git.commit ? "allowed" : "denied"} · PUSH: ${git.pushTaskBranch ? "allowed" : "denied"} · FORCE_PUSH/MERGE/DEPLOY: denied`,
		);
		if (!brief) {
			lines.push(
				"No V3 brief in this turn — you are READ-ONLY and hold no git authority.",
			);
		} else if (brief.malformed.length > 0) {
			lines.push(
				`Brief is malformed and was rejected fail-closed (${brief.malformed.join("; ")}). You are READ-ONLY.`,
			);
		}
	}
	// The bash allowlist compares full paths, so state the exact one instead of
	// letting the agent guess and get denied for a near-miss.
	const dir = scriptsDir();
	if (role === "peer") {
		lines.push("", `Ask the Lead with exactly: node ${dir}/team-communication.mjs ask-lead '<json>'`);
	} else {
		lines.push("", `Check for hung agents with exactly: node ${dir}/watchdog.mjs '<json>'`);
	}
	lines.push(
		"",
		"Hard bounds, every turn: Paseo is the only control plane. Claude-native",
		"subagents (Agent/Task) are denied for every role — the Lead delegates only",
		"through mcp__paseo__create_agent. Denials arrive as PreToolUse errors; treat",
		"them as protocol, not as obstacles to route around.",
	);
	return lines.join("\n");
}

function sessionContext(role, brief, isFirstTurn) {
	const header = authorityHeader(role, brief);
	if (!isFirstTurn) return header;
	const rolePrompt = loadPrompt(role);
	const delta = loadPrompt("claude-runtime-delta");
	return [header, rolePrompt, delta].filter(Boolean).join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onUserPromptSubmit(role, event) {
	const sessionId = event.session_id;
	const prior = readState(sessionId);
	const promptText = event.prompt ?? event.prompt_text ?? "";
	const brief = briefFromPrompt(role, promptText);
	writeState(sessionId, {
		role,
		brief: serializeBrief(brief),
		peerMode: resolvePeerMode(brief),
		permissionMode: event.permission_mode ?? null,
		turns: (prior?.turns ?? 0) + 1,
		updatedAt: new Date().toISOString(),
	});
	return {
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: sessionContext(role, brief, !prior),
		},
	};
}

function onPreToolUse(role, event) {
	const state = readState(event.session_id);
	// Fail-closed: no state means no brief was seen this session, so a peer has
	// no authority. Never inherit, never assume.
	const brief = deserializeBrief(state?.brief);
	const reason = claudeToolBlockReason({
		role,
		toolName: String(event.tool_name ?? ""),
		toolInput: event.tool_input,
		brief,
		extraTools: extraTools(),
		scriptsDir: scriptsDir(),
	});
	if (!reason) return {};
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

async function main() {
	const role = detectClaudeRole();
	if (!role) return; // passive

	const raw = await readStdin();
	let event;
	try {
		event = JSON.parse(raw);
	} catch {
		// An unparseable payload on a tool call must not open the gate.
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason:
						"Paseo team policy could not parse the hook payload; denying fail-closed.",
				},
			}),
		);
		return;
	}

	switch (event.hook_event_name) {
		case "SessionStart":
			clearState(event.session_id);
			return;
		case "SessionEnd":
			clearState(event.session_id);
			return;
		case "UserPromptSubmit": {
			process.stdout.write(JSON.stringify(onUserPromptSubmit(role, event)));
			return;
		}
		case "PreToolUse": {
			const out = onPreToolUse(role, event);
			if (Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
			return;
		}
		default:
			return;
	}
}

main().catch((error) => {
	// Deny on the way out: an exception must not become an allow.
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: `Paseo team policy hook failed (${String(error?.message ?? error)}); denying fail-closed.`,
			},
		}),
	);
	process.exitCode = 0;
});
