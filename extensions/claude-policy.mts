/**
 * claude-policy.mts — Claude Code binding for the shared role policy.
 *
 * The rules live in ./policy-core.mts. This file only maps them onto Claude
 * Code's tool names and returns a single deny reason (or null) for one
 * PreToolUse decision.
 *
 * Two differences from the Pi binding shape the whole file:
 *
 *   1. There is no `mcp` proxy. Paseo tools arrive as real tool names
 *      (`mcp__paseo__create_agent`), so the target IS the tool name and
 *      classifyMcpInput/mcpScriptBlockReason have no analogue here.
 *   2. Claude Code has native subagents (Agent/Task). Pi did not, so the
 *      "Paseo is the only control plane" invariant does not fall out of the
 *      ported rules — it is enforced explicitly below, for every role.
 *
 * Everything is fail-closed: an unrecognized shape denies rather than allows.
 */

import {
	ALL_PASEO_TOOLS,
	LEAD_ALLOWED_MCP_TARGETS,
	SUPERVISOR_ALLOWED_MCP_TARGETS,
	callsAgentBrowserCli,
	callsPaseoCli,
	denyReason,
	gitAuthorityBlockReason,
	isAgentBrowserMcpTarget,
	leadCreateWorkspaceArgsBlockReason,
	matchesPaseoToolName,
	peerGitAuthority,
	policyWithAuthority,
	resolvePeerMode,
	supervisorCreateAgentArgsBlockReason,
	type ParsedTaskBrief,
	type TeamRole,
} from "./policy-core.mts";

// ---------------------------------------------------------------------------
// Claude Code tool names
// ---------------------------------------------------------------------------

/** Tools that mutate the workspace. Gated by MODE + EDIT_AUTHORITY. */
export const CLAUDE_WRITE_TOOLS = [
	"Write",
	"Edit",
	"MultiEdit",
	"NotebookEdit",
];

/**
 * Native delegation. Denied for EVERY role: Paseo is the only control plane,
 * and a native subagent is a second one that Paseo cannot see, bound, or
 * account for. The Lead delegates through mcp__paseo__create_agent.
 */
export const CLAUDE_SUBAGENT_TOOLS = ["Agent", "Task", "TaskCreate"];

/** Shell surfaces. Guarded by the same heuristics as the Pi binding. */
export const CLAUDE_SHELL_TOOLS = ["Bash", "PowerShell", "BashOutput"];

const MCP_TOOL_RE = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/;

/** Split `mcp__<server>__<tool>` into its parts, or null for a builtin tool. */
export function parseMcpToolName(
	name: string,
): { server: string; tool: string } | null {
	const match = name.match(MCP_TOOL_RE);
	if (!match || match[1] === undefined || match[2] === undefined) return null;
	return { server: match[1], tool: match[2] };
}

/**
 * A Paseo orchestration tool, by either spelling: the MCP name Paseo injects
 * (`mcp__paseo__create_agent`) or a bare Paseo tool name. matchesPaseoToolName
 * already handles the suffix form, so a renamed MCP server still matches.
 */
export function isPaseoTool(name: string): boolean {
	const parsed = parseMcpToolName(name);
	if (parsed?.server === "paseo") return true;
	return matchesPaseoToolName(name, ALL_PASEO_TOOLS);
}

/** The Paseo tool being called, stripped of any MCP server prefix. */
export function paseoToolTarget(name: string): string {
	return parseMcpToolName(name)?.tool ?? name;
}

// ---------------------------------------------------------------------------
// Support-script bash allowlist
//
// The Pi binding registers peer_ask_lead and team_watchdog as typed tools.
// Claude Code reaches them through Bash instead, so each is allowed as ONE
// exact command form — same approach as EXACT_PUSH_RE in the core. Anything
// chained, redirected or reordered fails the match and falls through to the
// ordinary bash guards.
// ---------------------------------------------------------------------------

/**
 * Shape of the two sanctioned commands. The script path is CAPTURED, not just
 * pattern-matched on its filename, because matching the filename alone lets a
 * write-mode Peer author its own `team-communication.mjs` inside its owned
 * scope and run arbitrary code through the allowlist. The captured path must
 * equal the installed absolute path — the same "pin the value, not the shape"
 * rule that makes EXACT_PUSH_RE bind to agent/<TASK_ID>.
 */
const ASK_LEAD_SHAPE_RE =
	/^\s*node\s+(?:"([^"]+)"|'([^']+)'|([^\s'"]+))\s+ask-lead\s+(?:'[^']*'|"[^"]*")\s*$/;

const WATCHDOG_SHAPE_RE =
	/^\s*node\s+(?:"([^"]+)"|'([^']+)'|([^\s'"]+))(?:\s+(?:'[^']*'|"[^"]*"))?\s*$/;

function matchedScriptPath(command: string, shape: RegExp): string | null {
	const match = command.match(shape);
	if (!match) return null;
	return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Compare a command's script path against the one sanctioned absolute path.
 * Fail-closed: with no known scripts directory nothing can be verified, so
 * nothing is allowed.
 */
function isSanctionedScript(
	command: string,
	shape: RegExp,
	scriptsDir: string | undefined,
	fileName: string,
): boolean {
	if (!scriptsDir) return false;
	const actual = matchedScriptPath(command, shape);
	if (actual === null) return false;
	const dir = scriptsDir.replace(/[/\\]+$/, "");
	const expected = `${dir}/${fileName}`;
	// Agents write "~/..." as readily as an absolute path, and the docs show it
	// that way. Expanding the leading ~ here is not a loosening: it resolves to
	// exactly one path, which still has to equal the sanctioned one.
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const resolved = home && actual.startsWith("~/") ? `${home}/${actual.slice(2)}` : actual;
	return resolved === expected || resolved === expected.replace(/\//g, "\\");
}

export function isExactAskLeadCommand(command: string, scriptsDir?: string): boolean {
	return isSanctionedScript(command, ASK_LEAD_SHAPE_RE, scriptsDir, "team-communication.mjs");
}

export function isExactWatchdogCommand(command: string, scriptsDir?: string): boolean {
	return isSanctionedScript(command, WATCHDOG_SHAPE_RE, scriptsDir, "watchdog.mjs");
}

/**
 * Governance graph: read-only topology snapshot (who leads whom, who owns what
 * scope). Observing topology is the Supervisor's job, so it is the second
 * shell command the Supervisor may run.
 *
 * The flag allowlist is closed, not open. `--serve` is deliberately absent:
 * binding a listening socket outlives the turn that started it and is a
 * different class of authority from reading state — an agent that can leave a
 * server running has escaped the turn boundary the rest of this policy relies
 * on. A human runs `--serve` from their own shell.
 *
 * `--out <path>` is also absent: it writes a file, and the Supervisor has no
 * write authority. Read the JSON from stdout instead.
 */
const GOVERNANCE_GRAPH_SHAPE_RE =
	/^\s*node\s+(?:"([^"]+)"|'([^']+)'|([^\s'"]+))((?:\s+--(?:all|json))*)\s*$/;

export function isExactGovernanceGraphCommand(command: string, scriptsDir?: string): boolean {
	return isSanctionedScript(command, GOVERNANCE_GRAPH_SHAPE_RE, scriptsDir, "governance-graph.mjs");
}

/**
 * Peers must not drive Claude Code from the shell either — spawning a nested
 * `claude` is the same bypass class as spawning a nested `paseo`.
 *
 * Matches only at COMMAND POSITION (string start, or after a shell separator),
 * optionally path-prefixed. A bare mention is not an invocation: `grep -r
 * claude src/`, `npm test -- --grep claude` and `cat ~/.claude` are ordinary
 * commands a Peer is entitled to run, and callsPaseoCli avoids the same trap by
 * requiring a subcommand.
 */
const CLAUDE_CLI_RE =
	/(?:^|[|;&]+\s*|\$\(\s*|`\s*)(?:[^\s|;&`$()]*[/\\])?claude(?:\.(?:cmd|exe|ps1|sh))?(?=\s|$)/i;

export function callsClaudeCli(command: string): boolean {
	return CLAUDE_CLI_RE.test(command);
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface ClaudeToolCall {
	role: TeamRole;
	toolName: string;
	/** Claude passes the real argument object; no proxy unwrapping needed. */
	toolInput: unknown;
	/** Parsed from THIS turn's prompt. null ⇒ unbriefed ⇒ read-only. */
	brief: ParsedTaskBrief | null;
	/** Extra tools opted in via PASEO_TEAM_EXTRA_TOOLS. */
	extraTools?: string[];
	/**
	 * Absolute directory holding the installed support scripts. Required for
	 * the ask-lead / watchdog allowlist; without it neither is permitted.
	 */
	scriptsDir?: string;
}

function bashCommand(toolInput: unknown): string {
	if (typeof toolInput !== "object" || toolInput === null) return "";
	const command = (toolInput as Record<string, unknown>).command;
	return typeof command === "string" ? command : "";
}

function paseoMcpBlockReason(role: TeamRole, toolName: string, toolInput: unknown): string | null {
	const target = paseoToolTarget(toolName);
	if (role === "peer") {
		return "Peer cannot orchestrate agents or manage workspaces. Report a DEPENDENCY_REQUEST to the Lead instead.";
	}
	const allowed =
		role === "lead" ? LEAD_ALLOWED_MCP_TARGETS : SUPERVISOR_ALLOWED_MCP_TARGETS;
	if (!matchesPaseoToolName(target, allowed)) {
		return role === "supervisor"
			? `Supervisor may only call monitoring tools (list_agents, get_agent_status, get_agent_activity, send_agent_prompt) plus a gated lead-recovery create_agent. "${target}" is blocked — send an observation to the Lead instead.`
			: `"${target}" is not in the ${role} Paseo allowlist (discovery, workspace, monitoring, orchestration, permissions).`;
	}
	if (role === "supervisor" && matchesPaseoToolName(target, ["create_agent"])) {
		return supervisorCreateAgentArgsBlockReason(toolInput);
	}
	if (role === "lead" && matchesPaseoToolName(target, ["create_workspace"])) {
		return leadCreateWorkspaceArgsBlockReason(toolInput);
	}
	return null;
}

/**
 * The single policy decision for one Claude Code tool call.
 * Returns a human-readable deny reason, or null to allow.
 */
export function claudeToolBlockReason(call: ClaudeToolCall): string | null {
	const { role, toolName, toolInput, brief } = call;
	const extra = new Set(call.extraTools ?? []);
	if (extra.has(toolName)) return null;

	const peerMode = resolvePeerMode(brief);
	const policy = policyWithAuthority(role, peerMode, brief);

	// 1. Native delegation is never allowed — Paseo is the only control plane.
	if (CLAUDE_SUBAGENT_TOOLS.includes(toolName)) {
		return role === "lead"
			? `"${toolName}" is a Claude-native subagent, which Paseo cannot see, bound or account for. Delegate through mcp__paseo__create_agent so the child is a real Paseo agent.`
			: `"${toolName}" is a Claude-native subagent and is denied for the ${role} role. Only the Lead delegates, and only through Paseo.`;
	}

	// 2. Paseo orchestration tools.
	if (isPaseoTool(toolName)) {
		return paseoMcpBlockReason(role, toolName, toolInput);
	}

	// 3. Every other MCP server. The Pi binding allowlisted proxy targets; the
	//    same rule applies here, with agent-browser as the per-turn exception.
	const mcp = parseMcpToolName(toolName);
	if (mcp) {
		if (isAgentBrowserMcpTarget(toolName) || mcp.server.includes("agent")) {
			if (role === "peer" && !policy.allow.includes("mcp")) {
				return "Peer browser MCP is not authorized for this turn. Lead must send a V3 brief with BROWSER_MCP_AUTHORITY: allowed.";
			}
			if (isAgentBrowserMcpTarget(toolName)) return null;
		}
		if (role === "peer") {
			return `"${toolName}" is an MCP tool outside this Peer's authority. Only agent-browser is grantable, via BROWSER_MCP_AUTHORITY. Report a DEPENDENCY_REQUEST to the Lead instead.`;
		}
		if (role === "supervisor") {
			return `Supervisor is observation-only; "${toolName}" is outside the monitoring allowlist. Send an observation to the Lead instead.`;
		}
		return null;
	}

	// 4. Workspace mutation.
	if (CLAUDE_WRITE_TOOLS.includes(toolName)) {
		if (role === "supervisor") {
			return denyReason(role, peerMode, "write");
		}
		if (role === "lead") {
			return policy.allow.includes("write")
				? null
				: "Lead does not write product code by default. Delegate implementation to an Engineer Peer, or set PASEO_TEAM_LEAD_WRITE=1 for coordination artifacts the Workspace Protocol allows.";
		}
		if (peerMode === "write" && !policy.allow.includes("write")) {
			return "EDIT_AUTHORITY is denied for this task even though MODE is write. Report AUTHORITY_MISMATCH to the Lead.";
		}
		if (!policy.allow.includes("write")) {
			return denyReason(role, peerMode, "write");
		}
		return null;
	}

	// 5. Shell.
	if (CLAUDE_SHELL_TOOLS.includes(toolName)) {
		const command = bashCommand(toolInput);
		if (role === "supervisor") {
			if (isExactWatchdogCommand(command, call.scriptsDir)) return null;
			if (isExactGovernanceGraphCommand(command, call.scriptsDir)) return null;
			return "Supervisor shell authority is limited to the read-only watchdog and governance-graph snapshot (no --serve, no --out). Send an observation to the Lead instead.";
		}
		if (role === "peer") {
			if (isExactAskLeadCommand(command, call.scriptsDir)) return null;
			if (isExactWatchdogCommand(command, call.scriptsDir)) {
				return "team_watchdog is restricted to Lead and Supervisor agents.";
			}
			if (callsPaseoCli(command)) {
				return "Peer cannot drive the Paseo CLI from bash (would bypass the tool policy). Report a DEPENDENCY_REQUEST to the Lead instead.";
			}
			if (callsClaudeCli(command)) {
				return "Peer cannot spawn a nested Claude Code session from bash — that is a second control plane Paseo cannot see. Report a DEPENDENCY_REQUEST to the Lead instead.";
			}
			if (callsAgentBrowserCli(command)) {
				return "Peer cannot run agent-browser CLI through bash; BROWSER_MCP_AUTHORITY only permits the typed agent-browser MCP surface.";
			}
			return gitAuthorityBlockReason(
				command,
				peerGitAuthority(brief),
				brief?.fields.get("TASK_ID"),
			);
		}
		return null;
	}

	// 6. Read-only builtins fall through.
	return null;
}
