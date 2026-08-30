/**
 * policy-core.mts — runtime-agnostic role policy for the Paseo team pack.
 *
 * Pure logic shared by every runtime adapter: role detection, the per-role
 * tool tables, the strict V3 task-brief parser, peer authority resolution and
 * the bash guards. It imports nothing from any agent runtime, so a
 * Claude-Code-only host never pulls in the Pi package.
 *
 * Runtime bindings live next to it:
 *   - paseo-team-policy.ts  — Pi extension (setActiveTools + tool_call)
 *   - claude-policy.mts     — Claude Code tool names + PreToolUse decisions
 *
 * Fail-closed invariants are documented on the individual functions; the two
 * that govern everything else are:
 *   - authority is recomputed from the CURRENT turn's V3 brief, never
 *     inherited across turns;
 *   - anything unparseable resolves to read-only with all authority denied.
 */

export type TeamRole = "supervisor" | "lead" | "peer";
export type PeerMode = "write" | "read-only";

export function detectRole(): TeamRole | undefined {
	const raw = process.env.PASEO_PI_ROLE?.trim().toLowerCase();
	return raw === "supervisor" || raw === "lead" || raw === "peer"
		? raw
		: undefined;
}

/** Kept for API compatibility; the extension factory re-detects lazily. */
export const role: TeamRole | undefined = detectRole();

// ---------------------------------------------------------------------------
// Tool policy tables
// ---------------------------------------------------------------------------

export const PASEO_TOOLS = {
	discovery: ["list_providers", "list_models", "inspect_provider"],
	workspace: ["create_workspace", "list_workspaces", "archive_workspace"],
	monitoring: ["list_agents", "get_agent_status", "get_agent_activity"],
	orchestration: [
		"create_agent",
		"send_agent_prompt",
		"update_agent",
		"cancel_agent",
		"archive_agent",
	],
	/**
	 * Lead needs permission triage: an agent-scoped Peer that raises a
	 * permission request otherwise deadlocks the workflow. Supervisor must
	 * NOT get these (permission answers are an authority act, not monitoring).
	 */
	permissions: ["list_pending_permissions", "respond_to_permission"],
} as const;

export const ALL_PASEO_TOOLS: string[] = [
	...PASEO_TOOLS.discovery,
	...PASEO_TOOLS.workspace,
	...PASEO_TOOLS.monitoring,
	...PASEO_TOOLS.orchestration,
];

export const LEAD_ALLOWED_MCP_TARGETS: string[] = [
	...PASEO_TOOLS.discovery,
	...PASEO_TOOLS.workspace,
	...PASEO_TOOLS.monitoring,
	...PASEO_TOOLS.orchestration,
	...PASEO_TOOLS.permissions,
];

/** pi-mcp-adapter proxy tools — Paseo tools are reached through the `mcp` tool. */
const MCP_TOOLS = ["mcp", "mcp_script"];
export const PEER_COMMUNICATION_TOOL = "peer_ask_lead";
export const TEAM_WATCHDOG_TOOL = "team_watchdog";
const PI_READ_ONLY = ["read", "bash", PEER_COMMUNICATION_TOOL];
const PI_WRITE = ["read", "write", "edit", "bash", PEER_COMMUNICATION_TOOL];

/**
 * agent-browser MCP names are normalized by pi-mcp-adapter. Keep this prefix
 * allowlist explicit: a bare `open`/`click` target could belong to another
 * MCP server and must never be treated as browser authority.
 */
const AGENT_BROWSER_MCP_PREFIXES = [
	"agent_browser_",
	"agent-browser_",
	"agent_browser:",
	"agent-browser:",
	"mcp__agent_browser__",
	"mcp__agent-browser__",
];
export function isAgentBrowserMcpTarget(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return AGENT_BROWSER_MCP_PREFIXES.some((prefix) =>
		normalized.startsWith(prefix),
	);
}

export function callsAgentBrowserCli(command: string): boolean {
	// This is a deny heuristic, not a shell parser: block every literal
	// agent-browser reference in a Peer bash command so wrappers/aliases do not
	// reopen the CLI surface. The typed MCP path is checked separately.
	return /(?:^|[^a-z0-9])agent-browser(?:\.(?:cmd|exe|ps1|sh))?(?=$|[^a-z0-9])/i.test(
		command,
	);
}

/** Monitoring-only Paseo tools — the supervisor's default surface. */
export const SUPERVISOR_MONITORING_TARGETS: string[] = [
	"list_agents",
	"get_agent_status",
	"get_agent_activity",
	"send_agent_prompt",
];

/**
 * Paseo tools the supervisor may call through the MCP proxy. Fail-closed:
 * anything else in the catalog (terminals, workspace scripts, schedules,
 * discovery, orchestration, permissions, ...) is blocked. send_agent_prompt
 * is allowed so the supervisor can deliver observations to the Lead.
 * create_agent is the SINGLE orchestration exception — a gated lead-recovery
 * action whose arguments are validated by supervisorCreateAgentBlockReason.
 * Raw orchestration (peers, workspaces, discovery, arbitrary model choice)
 * stays blocked.
 */
export const SUPERVISOR_ALLOWED_MCP_TARGETS: string[] = [
	...SUPERVISOR_MONITORING_TARGETS,
	"create_agent",
];

/**
 * Stricter set for the mcp_script backstop scan: create_agent is excluded
 * because a script's arguments cannot be statically verified (the arg guard
 * only runs on direct `mcp` proxy calls). Supervisor mcp_script is already
 * hard-denied at the policy level — this is defense in depth only.
 */
export const SUPERVISOR_MCP_SCRIPT_TARGETS: string[] = SUPERVISOR_MONITORING_TARGETS;

/**
 * Match a possibly-prefixed proxy tool name against known Paseo tool names.
 * Handles "paseo_list_providers" and "server:list_providers" forms without
 * mangling bare names like "list_providers" (whose first segment is part of
 * the name itself).
 */
export function matchesPaseoToolName(name: string, known: string[]): boolean {
	return (
		known.includes(name) ||
		known.some((t) => name.endsWith(`_${t}`) || name.endsWith(`:${t}`))
	);
}

export interface Policy {
	/** Pure allowlist applied via setActiveTools(). */
	allow: string[];
	/** Backstop names blocked in tool_call. */
	deny: string[];
}

function leadWriteEnabled(): boolean {
	const raw = process.env.PASEO_TEAM_LEAD_WRITE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

export function policyFor(role: TeamRole, peerMode: PeerMode): Policy {
	switch (role) {
		case "lead":
			return {
				allow: [
					...(leadWriteEnabled() ? PI_WRITE : PI_READ_ONLY).filter(
						(tool) => tool !== PEER_COMMUNICATION_TOOL,
					),
					TEAM_WATCHDOG_TOOL,
					...LEAD_ALLOWED_MCP_TARGETS,
					...MCP_TOOLS,
				],
				deny: [],
			};
		case "supervisor":
			return {
				allow: ["read", "mcp", TEAM_WATCHDOG_TOOL, ...PASEO_TOOLS.monitoring, "send_agent_prompt"],
				deny: ["write", "edit", "mcp_script", ...ALL_PASEO_TOOLS],
			};
		case "peer":
			return peerMode === "write"
				? { allow: [...PI_WRITE], deny: [...ALL_PASEO_TOOLS, ...MCP_TOOLS] }
				: {
						allow: [...PI_READ_ONLY],
						deny: [...ALL_PASEO_TOOLS, ...MCP_TOOLS, "write", "edit"],
					};
	}
}

/**
 * Effective peer policy for the CURRENT turn. `MODE: write` grants write/edit
 * tools only when the brief also grants edit authority: an explicit
 * `EDIT_AUTHORITY: denied` (or a fail-closed V3 brief) strips write/edit
 * even on a write-mode turn.
 */
export function policyWithAuthority(
	role: TeamRole,
	peerMode: PeerMode,
	brief: ParsedTaskBrief | null,
): Policy {
	const policy = policyFor(role, peerMode);
	if (role !== "peer") return policy;

	const authority = peerAuthority(brief);
	const allow = [...policy.allow];
	const deny = [...policy.deny];
	if (authority.browserMcp) {
		allow.push("mcp");
		const mcpIndex = deny.indexOf("mcp");
		if (mcpIndex >= 0) deny.splice(mcpIndex, 1);
	}
	if (peerMode === "write" && !authority.edit) {
		return {
			allow: allow.filter((t) => t !== "write" && t !== "edit"),
			deny: [...new Set([...deny, "write", "edit"])],
		};
	}
	return { allow: [...new Set(allow)], deny: [...new Set(deny)] };
}

export function denyReason(
	role: TeamRole,
	peerMode: PeerMode,
	toolName: string,
): string {
	if (role === "peer" && (toolName === "mcp" || toolName === "mcp_script")) {
		return "Peer cannot use the MCP proxy unless the current V3 brief grants BROWSER_MCP_AUTHORITY: allowed. Paseo orchestration MCP remains forbidden. Report a DEPENDENCY_REQUEST to the Lead instead.";
	}
	if (role === "peer" && matchesPaseoToolName(toolName, ALL_PASEO_TOOLS)) {
		return "Peer cannot orchestrate agents or manage workspaces. Report a DEPENDENCY_REQUEST to the Lead instead.";
	}
	if (
		role === "peer" &&
		peerMode !== "write" &&
		(toolName === "write" || toolName === "edit")
	) {
		return "This Peer session is read-only (MODE: read-only). Propose the change in your report instead of editing files.";
	}
	if (role === "supervisor" && (toolName === "write" || toolName === "edit")) {
		return "Supervisor cannot modify product code. Send an observation to the Lead instead.";
	}
	if (role === "supervisor" && toolName === "mcp_script") {
		return "Supervisor cannot use mcp_script: dynamic MCP dispatch cannot be verified against the monitoring allowlist. Call monitoring tools individually through the mcp proxy (list_agents, get_agent_status, get_agent_activity, send_agent_prompt).";
	}
	if (role === "supervisor") {
		return "Supervisor cannot create or manage agents or workspaces. Send an observation to the Lead instead.";
	}
	return `Tool "${toolName}" is blocked by the ${role} role policy.`;
}

// ---------------------------------------------------------------------------
// Bash CLI guard — peers must not drive Paseo from the shell to bypass the
// tool policy. Heuristic only; not an authorization boundary.
// ---------------------------------------------------------------------------

const PASEO_CLI_RE =
	/\b(paseo|paseo-pi|pio)(?:\.(?:cmd|exe|ps1|sh))?\s+(?:run|send|ls|agent|workspace|provider|schedule|heartbeat|daemon|status|attach|logs|stop|delete|archive|inspect|wait|import|clone|onboard|start|restart|hub|chat|terminal|script|loop|permit|speech|hooks|help)\b/i;

export function callsPaseoCli(command: string): boolean {
	return PASEO_CLI_RE.test(command);
}

export function mcpAllowedTargets(role: TeamRole): string[] {
	switch (role) {
		case "supervisor":
			return SUPERVISOR_ALLOWED_MCP_TARGETS;
		case "lead":
			return LEAD_ALLOWED_MCP_TARGETS;
		case "peer":
			return [];
	}
}

// ---------------------------------------------------------------------------
// Strict task brief (PASEO_TEAM_TASK_V1 | V2 legacy header | V3 marker block)
// ---------------------------------------------------------------------------

export type BriefVersion = 1 | 2 | 3;

export interface ParsedTaskBrief {
	version: BriefVersion;
	/** null when MODE is missing or invalid — always resolves read-only. */
	mode: PeerMode | null;
	/** Human-readable integrity issues found while parsing the brief. */
	malformed: string[];
	/** Uppercase FIELD → first occurrence value (trimmed). */
	fields: Map<string, string>;
}

const BRIEF_HEADER_RE = /^PASEO_TEAM_TASK_V([12])$/;
const V3_BEGIN = "PASEO_TEAM_TASK_V3_BEGIN";
const V3_END = "PASEO_TEAM_TASK_V3_END";
const BRIEF_FIELD_RE = /^([A-Z][A-Z0-9_]*):\s*(.*)$/;
const AUTHORITY_FIELDS = [
	"EDIT_AUTHORITY",
	"BROWSER_MCP_AUTHORITY",
	"COMMIT_AUTHORITY",
	"PUSH_TASK_BRANCH_AUTHORITY",
	"FORCE_PUSH_AUTHORITY",
	"MERGE_AUTHORITY",
	"DEPLOY_AUTHORITY",
] as const;

/**
 * V3 field allowlist. Anything outside this set makes the whole brief
 * fail-closed (read-only, all authorities denied) — unknown structure is
 * treated as hostile input, not as free text to ignore.
 */
const V3_ALLOWED_FIELDS = new Set([
	"TASK_ID",
	"PROJECT_ID",
	"DISPOSITION",
	"MODE",
	"ASSIGNED_HOST_ID",
	"ASSIGNED_PASEO_PROVIDER",
	"ASSIGNED_MODEL",
	"ASSIGNED_THINKING",
	"WORKSPACE_REF",
	"AGENT_REF",
	"EXPECTED_BASE_SHA",
	"ASSIGNED_CANDIDATE_SHA",
	"OWNED_SCOPE",
	"EXCLUDED_SCOPE",
	"VERIFICATION_PROFILE",
	"RETURN_CHANNEL",
	...AUTHORITY_FIELDS,
]);

/**
 * Parse a V3 marker-block brief. The block starts at the exact first
 * non-empty line `PASEO_TEAM_TASK_V3_BEGIN` and ends at the first line that
 * trims to `PASEO_TEAM_TASK_V3_END`. Only lines *before* the end marker are
 * field-bearing; the task body after it is untrusted text and can never
 * grant authority.
 *
 * Fail-closed rules (any hit → mode null, fields dropped):
 *   - begin marker without end marker;
 *   - unparseable line inside the block;
 *   - field outside the allowlist;
 *   - duplicate field (any field — cheaply catches injected overrides;
 *     duplicate *authority* fields are the classic injection vector);
 *   - missing/invalid MODE or malformed authority values.
 */
function parseV3Brief(lines: string[]): ParsedTaskBrief {
	const malformed: string[] = [];
	const fields = new Map<string, string>();
	let begin = -1;
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i]?.trim() ?? "").length > 0) {
			begin = i;
			break;
		}
	}
	let end = -1;
	for (let i = begin + 1; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === V3_END) {
			end = i;
			break;
		}
	}
	if (end < 0) {
		malformed.push("V3 brief has no closing PASEO_TEAM_TASK_V3_END marker");
	} else {
		for (let i = begin + 1; i < end; i++) {
			const line = (lines[i] ?? "").trim();
			if (line.length === 0) continue;
			const match = line.match(BRIEF_FIELD_RE);
			if (!match || match[1] === undefined || match[2] === undefined) {
				malformed.push(`unparseable line in V3 brief: "${line}"`);
				continue;
			}
			const key = match[1];
			if (!V3_ALLOWED_FIELDS.has(key)) {
				malformed.push(`unknown V3 brief field "${key}"`);
				continue;
			}
			if (fields.has(key)) {
				malformed.push(
					AUTHORITY_FIELDS.includes(key as never)
						? `duplicate authority field "${key}"`
						: `duplicate field "${key}"`,
				);
				continue;
			}
			fields.set(key, match[2].trim());
		}
	}

	const failClosed = (): ParsedTaskBrief => ({
		version: 3,
		mode: null,
		malformed,
		fields: new Map(),
	});

	let mode: PeerMode | null = null;
	const rawMode = fields.get("MODE");
	if (rawMode === undefined) {
		malformed.push("missing MODE field");
	} else {
		const normalized = rawMode.toLowerCase();
		if (normalized === "write" || normalized === "read-only") {
			mode = normalized;
		} else {
			malformed.push(`invalid MODE value "${rawMode}"`);
		}
	}
	for (const field of AUTHORITY_FIELDS) {
		const value = fields.get(field);
		if (value !== undefined) {
			const normalized = value.toLowerCase();
			if (normalized !== "allowed" && normalized !== "denied") {
				malformed.push(`invalid ${field} value "${value}"`);
			}
		}
	}
	if (malformed.length > 0) return failClosed();
	return { version: 3, mode, malformed, fields };
}

/**
 * Legacy V1/V2 briefs historically scanned the WHOLE prompt for authority
 * fields — an authorization-injection vector (a body line like
 * `COMMIT_AUTHORITY: allowed` granted real authority). V3 closes it.
 * V1/V2 are accepted for identity/mode parsing only; resolvePeerMode and
 * peerGitAuthority below treat them as read-only with all authority denied.
 */
export function isLegacyBrief(brief: ParsedTaskBrief): boolean {
	return brief.version < 3;
}

/**
 * Parse a task brief. Returns null when the prompt does not start with a
 * recognized header — callers must treat that as an unbriefed (read-only)
 * turn. A recognized header with a missing/invalid MODE yields
 * `mode: null` plus a malformed note, never silent write access.
 */
export function parseTaskBrief(prompt: string): ParsedTaskBrief | null {
	const lines = prompt.split(/\r?\n/);
	const firstNonEmpty = lines.map((l) => l.trim()).find((l) => l.length > 0);
	if (!firstNonEmpty) return null;
	if (firstNonEmpty === V3_BEGIN) return parseV3Brief(lines);
	const headerMatch = firstNonEmpty.match(BRIEF_HEADER_RE);
	if (!headerMatch || !headerMatch[1]) return null;
	const version: BriefVersion = headerMatch[1] === "2" ? 2 : 1;

	const fields = new Map<string, string>();
	for (const line of lines) {
		const fieldMatch = line.match(BRIEF_FIELD_RE);
		const key = fieldMatch?.[1];
		if (
			key !== undefined &&
			fieldMatch?.[2] !== undefined &&
			!fields.has(key)
		) {
			fields.set(key, fieldMatch[2].trim());
		}
	}

	const malformed: string[] = [];
	let mode: PeerMode | null = null;
	const rawMode = fields.get("MODE");
	if (rawMode === undefined) {
		malformed.push("missing MODE field");
	} else {
		const normalized = rawMode.toLowerCase();
		if (normalized === "write" || normalized === "read-only") {
			mode = normalized;
		} else {
			malformed.push(`invalid MODE value "${rawMode}"`);
		}
	}

	if (version === 2) {
		for (const field of AUTHORITY_FIELDS) {
			const value = fields.get(field);
			if (value !== undefined) {
				const normalized = value.toLowerCase();
				if (normalized !== "allowed" && normalized !== "denied") {
					malformed.push(
						`invalid ${field} value "${value}" (treated as denied)`,
					);
				}
			}
		}
	}

	// Legacy briefs are kept parseable for diagnostics, but their write mode
	// and authority fields are never honored (whole-prompt scan injection
	// surface closed by V3). Surface that loudly for /team-role debugging.
	if (mode === "write" || AUTHORITY_FIELDS.some((f) => fields.has(f))) {
		malformed.push(
			`legacy V${version} brief: MODE and *_AUTHORITY fields are ignored — only a V3 marker block can grant write/authority`,
		);
	}

	return { version, mode, malformed, fields };
}

/** Fail-closed mode resolution: unknown/incomplete/legacy brief → read-only. */
export function resolvePeerMode(brief: ParsedTaskBrief | null): PeerMode {
	if (brief === null) return "read-only";
	// Legacy V1/V2 briefs never grant write mode: their parser scanned the
	// whole prompt, so any body line could silently grant authority. Use V3.
	if (isLegacyBrief(brief)) return "read-only";
	return brief.mode ?? "read-only";
}

export interface PeerAuthority {
	edit: boolean;
	browserMcp: boolean;
	commit: boolean;
	pushTaskBranch: boolean;
	forcePush: boolean;
	merge: boolean;
	deploy: boolean;
}

function peerAuthority(brief: ParsedTaskBrief | null): PeerAuthority {
	if (brief === null || isLegacyBrief(brief)) {
		return {
			edit: false,
			browserMcp: false,
			commit: false,
			pushTaskBranch: false,
			forcePush: false,
			merge: false,
			deploy: false,
		};
	}
	const mode = resolvePeerMode(brief);
	return {
		edit: authorityField(brief, "EDIT_AUTHORITY") ?? mode === "write",
		browserMcp: authorityField(brief, "BROWSER_MCP_AUTHORITY") ?? false,
		commit: authorityField(brief, "COMMIT_AUTHORITY") ?? false,
		pushTaskBranch:
			authorityField(brief, "PUSH_TASK_BRANCH_AUTHORITY") ?? false,
		forcePush: false,
		merge: false,
		deploy: false,
	};
}

export function browserMcpAllowed(brief: ParsedTaskBrief | null): boolean {
	return peerAuthority(brief).browserMcp;
}

export type PeerGitAuthority = Omit<PeerAuthority, "browserMcp">;

function authorityField(
	brief: ParsedTaskBrief | null,
	field: string,
): boolean | undefined {
	const raw = brief?.fields.get(field);
	if (raw === undefined) return undefined;
	return raw.toLowerCase() === "allowed";
}

/**
 * Git authority for a peer turn. Defaults are fail-closed: commit and push
 * are denied unless the brief explicitly allows them; force-push, merge and
 * deploy are never allowed, even if a brief claims otherwise.
 */
export function peerGitAuthority(
	brief: ParsedTaskBrief | null,
): PeerGitAuthority {
	if (brief === null || isLegacyBrief(brief)) {
		// No brief, or a legacy V1/V2 brief (whole-prompt scan injection
		// surface): every authority is denied regardless of claimed fields.
		return {
			edit: false,
			commit: false,
			pushTaskBranch: false,
			forcePush: false,
			merge: false,
			deploy: false,
		};
	}
	const authority = peerAuthority(brief);
	return {
		edit: authority.edit,
		commit: authority.commit,
		pushTaskBranch: authority.pushTaskBranch,
		forcePush: authority.forcePush,
		merge: authority.merge,
		deploy: authority.deploy,
	};
}

// ---------------------------------------------------------------------------
// Peer git authority guard — heuristics on bash commands mirroring the
// PASEO CLI guard. Not an authorization boundary.
// ---------------------------------------------------------------------------

const GIT_COMMIT_RE = /\bgit\b[^|;&]*\bcommit\b/i;
const GIT_PUSH_RE = /\bgit\b[^|;&]*\bpush\b/i;

/**
 * Force-push detection over every `git push` segment of a command. Catches
 * the forms a flag-order/heuristic regex misses: `--force[:=...] variants`,
 * combined short flags (`-f`, `-uf`, `-fu`, ...) and forced refspecs
 * (`+HEAD:refs/...`, `+main`). Chained commands are split first so a
 * `git fetch && git push --force` chain cannot hide the flag.
 */
function detectForcePush(command: string): boolean {
	for (const segment of command.split(/[|;&]+/)) {
		if (!GIT_PUSH_RE.test(segment)) continue;
		if (/--force(?:-with-lease)?\b/i.test(segment)) return true;
		if (/(?:^|\s)-[a-z]*f[a-z]*(?:\s|$)/i.test(segment)) return true;
		if (/(?:^|\s)\+/i.test(segment)) return true; // forced refspec +src[:dst]
	}
	return false;
}

/**
 * The ONLY push form a peer may run when PUSH_TASK_BRANCH_AUTHORITY is
 * granted: upload HEAD to its own task branch on origin. Branch name must
 * be exactly agent/<TASK_ID> from the current brief — pushing any other
 * branch (main, a teammate's branch), other remotes, --all/--tags/--mirror
 * or deletions is structurally impossible in this form.
 */
const EXACT_PUSH_RE =
	/^\s*git\s+push\s+-u\s+origin\s+HEAD:refs\/heads\/([A-Za-z0-9][A-Za-z0-9._/-]*)\s*$/;

export function expectedTaskBranch(taskId: string | undefined): string | null {
	const id = taskId?.trim();
	if (!id || /\s/.test(id)) return null;
	return `agent/${id}`;
}

const GIT_MERGE_RE = /\bgit\b[^|;&]*\bmerge\b/i;
const GIT_AMEND_RE = /\bgit\b[^|;&]*\bcommit\b[^|;&]*--amend\b/i;

export function gitAuthorityBlockReason(
	command: string,
	authority: PeerGitAuthority,
	taskId?: string,
): string | null {
	if (detectForcePush(command)) {
		return "FORCE_PUSH_AUTHORITY is always denied for Peers (including -f/-uf/-fu, --force*= and +refspec forms). Ask the Lead to update the brief — peers never force-push.";
	}
	if (GIT_AMEND_RE.test(command)) {
		return "git commit --amend is always denied for Peers: a pushed branch must advance by NEW commits so the SHA chain stays reviewable. Create a new correction commit and (when granted) push it with the exact branch-scoped form.";
	}
	if (GIT_PUSH_RE.test(command)) {
		if (!authority.pushTaskBranch) {
			return "PUSH_TASK_BRANCH_AUTHORITY is denied for this task. Report AUTHORITY_MISMATCH to the Lead.";
		}
		const expected = expectedTaskBranch(taskId);
		const match = command.match(EXACT_PUSH_RE);
		if (expected === null || !match || match[1] !== expected) {
			return `Push authority is branch-scoped: only "git push -u origin HEAD:refs/heads/${expected ?? "agent/<TASK_ID>"}" is allowed. Other branches/remotes, --all, --tags, --mirror, deletions and chained commands are blocked. Push first, run other commands separately.`;
		}
	}
	if (GIT_COMMIT_RE.test(command) && !authority.commit) {
		return "COMMIT_AUTHORITY is denied for this task. Report AUTHORITY_MISMATCH to the Lead (or hand off a stable workspace snapshot instead of a SHA).";
	}
	if (GIT_MERGE_RE.test(command) && !authority.merge) {
		return "MERGE_AUTHORITY is always denied for Peers. Integration belongs to the Lead or Human.";
	}
	return null;
}

export function teamToolBlockReason(
	role: TeamRole,
	toolName: string,
	brief: ParsedTaskBrief | null,
): string | null {
	if (toolName === PEER_COMMUNICATION_TOOL) {
		if (role !== "peer") return "peer_ask_lead is restricted to Peer agents.";
		if (!brief || brief.version !== 3 || brief.malformed.length > 0) {
			return "peer_ask_lead requires a valid current V3 task brief.";
		}
	}
	if (toolName === TEAM_WATCHDOG_TOOL && role !== "lead" && role !== "supervisor") {
		return "team_watchdog is restricted to Lead and Supervisor agents.";
	}
	return null;
}

// ---------------------------------------------------------------------------
// Argument-level gates. These take the tool's argument object DIRECTLY.
// Pi reaches Paseo tools through an `mcp` proxy and must unwrap { tool, args }
// first; Claude Code calls mcp__paseo__<tool> with the args as tool_input, so
// it passes them straight through. The validation rules live here once.
// ---------------------------------------------------------------------------

const SUPERVISOR_RECOVERY_PURPOSES = new Set(["recovery", "bootstrap"]);
const HARNESS_AGENT_ROLES = new Set([
	"observer",
	"writer",
	"reviewer",
	"lead",
	"supervisor",
]);
const HARNESS_RETENTION = new Set(["ephemeral", "keep"]);

/** Machine ownership labels required on every team-created Paseo agent. */
export function lifecycleLabelsBlockReason(args: unknown): string | null {
	if (typeof args !== "object" || args === null) {
		return "create_agent requires an args object with lifecycle labels.";
	}
	const labels = (args as Record<string, unknown>).labels;
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
		return "create_agent requires a labels object with harness.owner/run/project/role/task/retention.";
	}
	const map = labels as Record<string, unknown>;
	if (map["harness.owner"] !== "paseo-claude-team") {
		return 'create_agent labels["harness.owner"] must be "paseo-claude-team".';
	}
	for (const key of ["harness.run", "harness.project", "harness.task"]) {
		if (typeof map[key] !== "string" || map[key].trim().length === 0) {
			return `create_agent labels["${key}"] is required.`;
		}
	}
	if (typeof map["harness.role"] !== "string" || !HARNESS_AGENT_ROLES.has(map["harness.role"])) {
		return `create_agent labels["harness.role"] must be one of ${[...HARNESS_AGENT_ROLES].join(", ")}.`;
	}
	if (typeof map["harness.retention"] !== "string" || !HARNESS_RETENTION.has(map["harness.retention"])) {
		return 'create_agent labels["harness.retention"] must be "ephemeral" or "keep".';
	}
	return null;
}

/**
 * Lifecycle labels are immutable after creation. Paseo merge-patches labels on
 * update_agent, so a patch that touches any harness.* key can rewrite the
 * ownership contract of a live agent — flipping harness.retention to
 * "ephemeral" REMOVES the reconciler's confirmed retention_keep veto and
 * manufactures a cleanup proposal. Fail closed on malformed shapes.
 */
/**
 * Per-role admission for the four pack skills. Exposing every skill to every
 * role is skill pollution: a Peer that loads paseo-team-lead drifts from its
 * bounded task into orchestration it has no authority to execute, and
 * paseo-premise-audit is whole-project scope handed to a one-scope agent.
 *
 * Peer admission is further bound to the current brief's DISPOSITION — the
 * reviewer skill belongs to an independent-reviewer turn and the premise audit
 * to a solution-architect turn, per docs/review-instruments.md. Non-pack
 * skills are out of scope here. config/skill-admission.json mirrors this
 * table for humans; test asserts the two never drift.
 */
export const PACK_SKILLS = Object.freeze([
	"paseo-team-lead",
	"paseo-ultra-review",
	"paseo-ocr-reviewer",
	"paseo-premise-audit",
	"repo-refresh",
]);
export const SKILL_ADMISSION: Readonly<Record<TeamRole, Readonly<Record<string, string | null>>>> = Object.freeze({
	// value: null = active; string = required DISPOSITION; absent = disabled.
	lead: Object.freeze({ "paseo-team-lead": null, "paseo-ultra-review": null }),
	peer: Object.freeze({
		"paseo-ocr-reviewer": "independent-reviewer",
		"paseo-premise-audit": "solution-architect",
	}),
	supervisor: Object.freeze({}),
});

export function skillBlockReason(
	role: TeamRole,
	skillName: unknown,
	brief: ParsedTaskBrief | null,
): string | null {
	if (typeof skillName !== "string" || skillName.trim() === "") {
		return "Skill invocation without a recognizable skill name. Refusing fail-closed.";
	}
	// Normalize before the membership test so path/scheme/case variants
	// (skills/x, ./skills/x, skill://x, x/SKILL.md, X) cannot slip a gated pack
	// skill past admission. Defense in depth: Claude's Skill contract already
	// passes an exact bare name, but the gate must not depend on that.
	const name = skillName
		.trim()
		.replace(/^skill:\/\//i, "")
		.replace(/^\.?\/?(?:skills\/)?/, "")
		.replace(/\/(?:SKILL(?:\.md)?)?$/i, "")
		.toLowerCase();
	if (!PACK_SKILLS.includes(name)) return null;
	const admission = SKILL_ADMISSION[role];
	if (!(name in admission)) {
		return `Skill "${name}" is not admitted for the ${role} role. Admitted: ${Object.keys(admission).sort().join(", ") || "(none)"}. Skill visibility is not authority.`;
	}
	const requiredDisposition = admission[name];
	if (requiredDisposition !== null) {
		// Only a valid V3 brief can carry authority — the same legacy guard every
		// sibling check applies (resolvePeerMode, peerAuthority, peer_ask_lead).
		// A V1/V2 header with a column-0 "DISPOSITION:" line is untrusted text.
		const disposition =
			brief !== null && brief.version === 3 && brief.malformed.length === 0
				? brief.fields.get("DISPOSITION")?.trim() ?? null
				: null;
		if (disposition !== requiredDisposition) {
			return `Skill "${name}" requires the current V3 brief to carry DISPOSITION: ${requiredDisposition} (current: ${disposition ?? "no valid V3 brief"}). Ask the Lead for a matching assignment.`;
		}
	}
	return null;
}

export function updateAgentLabelsBlockReason(args: unknown): string | null {
	if (typeof args !== "object" || args === null) {
		return "update_agent requires an args object. Refusing fail-closed.";
	}
	const labels = (args as Record<string, unknown>).labels;
	if (labels === undefined) return null;
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
		return "update_agent labels must be a plain object when present. Refusing fail-closed.";
	}
	// Reflect.ownKeys catches a `{"__proto__": {...}}` payload that Object.keys
	// misses; normalization catches case/whitespace variants the daemon might
	// fold server-side. Either would otherwise slip a harness.* patch through.
	const proto = Object.getPrototypeOf(labels);
	if (proto !== Object.prototype && proto !== null) {
		return "update_agent labels must be a plain object (unexpected prototype). Refusing fail-closed.";
	}
	// Labels are a string→string map. A non-string value (e.g. the object value
	// in a `{"__proto__": {...}}` payload) is malformed — reject before any
	// harness.* check so a nested lifecycle key cannot ride in on a weird shape.
	const ownKeys = Reflect.ownKeys(labels).filter((key): key is string => typeof key === "string");
	for (const key of ownKeys) {
		if (typeof (labels as Record<string, unknown>)[key] !== "string") {
			return `update_agent label "${key}" must have a string value. Refusing fail-closed.`;
		}
	}
	const touched = ownKeys.filter((key) => key.trim().toLowerCase().normalize("NFKC").startsWith("harness."));
	if (touched.length > 0) {
		return `update_agent must not patch lifecycle labels (${touched.sort().join(", ")}). They are set once at create_agent and are the reconciler's ownership evidence; changing harness.retention on a live agent would convert a keep veto into a cleanup candidate.`;
	}
	return null;
}

/**
 * Argument-level gate for supervisor create_agent through the MCP proxy.
 * The supervisor may create exactly ONE kind of agent: a successor Lead
 * (`claude-lead/<model-id>`), flagged recovery/bootstrap with a
 * project id and an explicit thinking level. Anything else — peers, other
 * providers, missing labels, missing thinking, malformed args — is blocked
 * fail-closed. The labels land on the created agent, so `paseo agent ls`
 * shows exactly why it exists (audit trail).
 */
export function supervisorCreateAgentArgsBlockReason(
	args: unknown,
): string | null {
	if (typeof args !== "object" || args === null) {
		return "Supervisor create_agent requires an args object (provider, labels, settings). Refusing fail-closed.";
	}
	const rec = args as Record<string, unknown>;
	const lifecycleReason = lifecycleLabelsBlockReason(args);
	if (lifecycleReason) return lifecycleReason;
	const provider = typeof rec.provider === "string" ? rec.provider : "";
	// claude-lead/<model-id>. Paseo splits at the FIRST slash only, so the model
	// id may itself contain slashes; require the lead provider and a non-empty
	// remainder, nothing more.
	if (!/^claude-lead\/[^/]+/.test(provider)) {
		return `Supervisor create_agent is lead-recovery only: provider must be "claude-lead/<model-id>" (got "${provider || "<missing>"}"). Peers and other providers are created by the Lead, never by the Supervisor.`;
	}
	const labels = rec.labels;
	if (typeof labels !== "object" || labels === null) {
		return "Supervisor create_agent requires labels to prove this is a gated recovery action.";
	}
	const labelMap = labels as Record<string, unknown>;
	if (labelMap["harness.role"] !== "lead") {
		return 'Supervisor recovery create_agent labels["harness.role"] must be "lead".';
	}
	const purpose = labelMap.purpose;
	if (
		typeof purpose !== "string" ||
		!SUPERVISOR_RECOVERY_PURPOSES.has(purpose)
	) {
		return `Supervisor create_agent labels.purpose must be "recovery" or "bootstrap" (got "${typeof purpose === "string" ? purpose : "<missing>"}").`;
	}
	const recoveryFor = labelMap.recovery_for;
	if (typeof recoveryFor !== "string" || recoveryFor.trim().length === 0) {
		return "Supervisor create_agent labels.recovery_for (project id) is required.";
	}
	const thinking =
		typeof rec.settings === "object" && rec.settings !== null
			? (rec.settings as Record<string, unknown>).thinkingOptionId
			: undefined;
	if (typeof thinking !== "string" || thinking.trim().length === 0) {
		return "Supervisor create_agent requires settings.thinkingOptionId (no daemon-default model — route from the approved Lead route).";
	}
	return null;
}

/**
 * Argument-level gate for Lead create_workspace through the MCP proxy —
 * Layer 1 of the reviewer isolation invariant (Layer 2 is the runtime
 * assertLinkedWorktree gate in ocr-review.mjs, which rejects any
 * non-worktree workspace with REVIEW_WORKSPACE_NOT_WORKTREE).
 *
 * MCP create_workspace args carry no disposition field, so reviewer intent
 * is declared through the workspace naming convention the Lead skill
 * mandates: reviewer workspaces are titled/slugged with "review". The gate
 * enforces:
 *   - isolation is explicit and valid ("local" | "worktree") — never a
 *     daemon default;
 *   - a review-marked workspace (title/worktreeSlug containing "review")
 *     MUST use worktree isolation; local is the exact anti-pattern the
 *     runtime gate rejects, so it is blocked before creation.
 */
export function leadCreateWorkspaceArgsBlockReason(args: unknown): string | null {
	if (typeof args !== "object" || args === null) {
		return 'Lead create_workspace requires an args object with an explicit isolation ("local" or "worktree"). Refusing fail-closed.';
	}
	const rec = args as Record<string, unknown>;
	const isolation =
		typeof rec.isolation === "string" ? rec.isolation.trim() : "";
	if (isolation !== "local" && isolation !== "worktree") {
		return `create_workspace requires explicit isolation "local" or "worktree" (got "${isolation || "<missing>"}") — never rely on a daemon default.`;
	}
	const markers = [rec.title, rec.worktreeSlug].filter(
		(value): value is string => typeof value === "string",
	);
	if (isolation !== "worktree" && markers.some((value) => /review/i.test(value))) {
		return 'An independent-reviewer workspace must use isolation "worktree" (a linked git worktree from the source repository). If the worktree cannot be created, report BLOCKED: REVIEW_WORKTREE_UNAVAILABLE — never fall back to a local workspace.';
	}
	return null;
}
