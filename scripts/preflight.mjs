#!/usr/bin/env node
// preflight.mjs — host readiness check for the paseo-claude-team role pack.
//
// Usage:
//   node scripts/preflight.mjs [--json] [--strict] [--host-id <id>] [--cluster <path>]
//                              [--routes <path>] [--skip-models]
//
// Checks (per host): node, git, paseo CLI + daemon, Claude Code CLI,
// the installed Claude runtime + hook wiring, the three claude-* providers,
// role-pack extension + prompts, Paseo role providers, model inventory,
// routing-config validity, per-model thinking support, cluster routing
// contract, endpoint env presence, agent-browser CDP mode + reachability,
// repository state.
//
// Never prints secret values: only env-var NAMES are checked/reported.
// Exit code 1 when any check fails. In --strict mode, warnings that affect
// the ability to route the current task (missing routing config, unreadable
// model inventory, silently-clamped thinking levels, missing required remote
// endpoint env) are escalated to failures — unverifiable is NOT a pass.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	RoutingError,
	buildProviderInventory,
	defaultClusterRoutingPath,
	defaultRoutingDir,
	loadClusterConfig,
	loadRoutingConfig,
	missingHostCapabilities,
	modelsCacheKey,
	resolveClusterRoute,
	resolveRoute,
	validateRemoteEndpoint,
	cmdPercentExpansionRisk,
	MODEL_CLASSES,
	PROVIDER_OK_STATUSES,
} from "./model-routing.mjs";

const PINNED = Object.freeze({
	paseo: "0.4.0",
	claude: "2.1.237",
	nodeMajor: 22,
});

// Fail closed on unknown flags. `--stict` running non-strict and printing
// ok:true is exactly the failure --strict exists to prevent (AXI principle #6:
// a swallowed flag silently disables a safety gate).
const KNOWN_FLAGS = new Set([
	"--json", "--strict", "--skip-models", "--hosts", "--version",
	"--host-id", "--cluster", "--routes",
]);
const VALUE_FLAGS = new Set(["--host-id", "--cluster", "--routes"]);
{
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (VALUE_FLAGS.has(token)) {
			// The value must exist and must not itself be a flag, or a typo like
			// `--routes --stict` silently swallows `--stict` as the value and the
			// unknown-flag gate never fires — the exact bypass --strict guards.
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("-")) {
				console.error(JSON.stringify({ ok: false, error: "missing_flag_value", flag: token }));
				process.exit(2);
			}
			i += 1;
			continue;
		}
		if (!KNOWN_FLAGS.has(token)) {
			console.error(JSON.stringify({
				ok: false,
				error: "unknown_flag",
				flag: token,
				known: [...KNOWN_FLAGS].sort(),
				hint: token.startsWith("--st") ? "did you mean --strict?" : undefined,
			}));
			process.exit(2);
		}
	}
}

import { policyDigest } from "./policy-digest.mjs";

// --version: print the pack identity and the digest of the governing bytes,
// nothing else. Two hosts on the same version MUST print the same digest;
// a one-byte prompt edit changes it. Reports embed this so a finding can be
// attributed to the exact policy that produced it.
if (process.argv.includes("--version")) {
	const digest = policyDigest();
	console.log(JSON.stringify({
		name: "paseo-claude-team",
		version: digest.version,
		policyDigest: digest.policyDigest,
		fileCount: digest.fileCount,
	}, null, 2));
	process.exit(0);
}

const wantJson = process.argv.includes("--json");
const skipModels = process.argv.includes("--skip-models");
const wantStrict = process.argv.includes("--strict");
const opt = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const routesPath = opt(
	"--routes",
	join(defaultRoutingDir(), "model-routing.local.json"),
);
// Not configurable: this path exists only to warn that a leftover legacy
// registry is no longer read. The cluster file is the only host source.
const legacyHostsPath = join(defaultRoutingDir(), "hosts.local.json");
const clusterPath = opt("--cluster", defaultClusterRoutingPath());
const hostIdArg = opt("--host-id", undefined);

const results = [];
function report(id, status, detail = "") {
	results.push({ id, status, detail });
	if (!wantJson) {
		const mark = status === "pass" ? "✓" : status === "warn" ? "⚠" : "✗";
		console.log(`${mark} ${id}${detail ? ` — ${detail}` : ""}`);
	}
}
const pass = (id, detail) => report(id, "pass", detail);
const warn = (id, detail) => report(id, "warn", detail);
const fail = (id, detail) => report(id, "fail", detail);
const clusterExplicit = process.argv.includes("--cluster");

/** In strict mode, route-affecting warnings are failures. */
const strictCheck = wantStrict ? fail : warn;

// On Windows, npm-installed CLIs (paseo, pi) are .cmd shims which execFile
// cannot spawn directly; route those through the shell via execSync. All
// arguments passed to tryExec are static literals (never user input), so
// joining them into a command string is safe.
const NEEDS_SHELL = process.platform === "win32";

function tryExec(cmd, argv, timeoutMs = 30000) {
	try {
		const stdout = NEEDS_SHELL
			? execSync([cmd, ...argv.map(String)].join(" "), {
					timeout: timeoutMs,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				})
			: execFileSync(cmd, argv, {
					timeout: timeoutMs,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				});
		return { ok: true, stdout };
	} catch (error) {
		return {
			ok: false,
			stdout: error?.stdout ? String(error.stdout) : "",
			error: String(error?.message ?? error),
		};
	}
}

function summarizeMessages() {
	if (results.some((r) => r.status === "fail")) return 1;
	return 0;
}

// --- node / git / CLIs --------------------------------------------------------

{
	const ocr = tryExec("ocr", ["version"]);
	if (!ocr.ok) {
		warn("ocr-cli", "ocr CLI unavailable — independent-reviewer OCR workflow is blocked (install @alibaba-group/open-code-review)");
	} else {
		const versionLine = ocr.stdout.trim().split(/\r?\n/)[0] || "";
		const parsed = versionLine.match(/open-code-review v(\d+)\.(\d+)\.(\d+)/i);
		// Compatibility is capability-based; the version only gates a warning
		// when it is below the verified 1.8.10 baseline or unparseable.
		const meetsBaseline =
			parsed &&
			(Number(parsed[1]) > 1 ||
				(Number(parsed[1]) === 1 &&
					(Number(parsed[2]) > 8 ||
						(Number(parsed[2]) === 8 && Number(parsed[3]) >= 10))));
		if (meetsBaseline) pass("ocr-cli", versionLine);
		else warn("ocr-cli", `${versionLine || "installed"} — below the verified open-code-review v1.8.10 baseline; reviewer wrapper capability probes will fail closed`);
		for (const command of ["preview", "rule"]) {
			const help = tryExec("ocr", ["delegate", command, "--help"]);
			if (help.ok && help.stdout.includes("--repo") && help.stdout.includes("--from")) pass(`ocr-capability:${command}`, "delegate capability available");
			else warn(`ocr-capability:${command}`, "delegate capability probe failed — reviewer wrapper will fail closed");
		}
	}
}
{
	const major = Number(process.versions.node.split(".")[0]);
	if (major >= PINNED.nodeMajor) pass("node", process.versions.node);
	else
		fail(
			"node",
			`node ${process.versions.node} < required ${PINNED.nodeMajor}`,
		);
}
{
	const git = tryExec("git", ["--version"]);
	if (git.ok) pass("git", git.stdout.trim());
	else fail("git", "git CLI not found");
}
{
	const v = tryExec("paseo", ["--version"]);
	if (!v.ok) fail("paseo-cli", "paseo CLI not found");
	else {
		const version = v.stdout.trim();
		if (version === PINNED.paseo) pass("paseo-cli", version);
		else
			warn(
				"paseo-cli",
				`detected ${version}, role pack was verified against ${PINNED.paseo}`,
			);
	}
}

// --- claude code CLI ----------------------------------------------------------
// The providers launch `claude`; if the binary is missing or too old, every
// role fails at spawn time rather than at policy time.
{
	const v = tryExec("claude", ["--version"]);
	if (!v.ok) {
		fail("claude-cli", "claude not found on PATH → the claude-* providers cannot start");
	} else {
		const version = (v.stdout.match(/[0-9]+\.[0-9]+\.[0-9]+/) ?? ["unknown"])[0];
		if (version === PINNED.claude) pass("claude-cli", version);
		else warn("claude-cli", `detected ${version}, role pack was verified against ${PINNED.claude}`);
	}
}

// --- daemon -------------------------------------------------------------------

let daemonUp = false;
{
	const status = tryExec("paseo", ["status", "--json"]);
	if (status.ok) {
		try {
			const parsed = JSON.parse(status.stdout);
			if (parsed.localDaemon) {
				daemonUp = true;
				pass("paseo-daemon", `${parsed.localDaemon} (${parsed.listen ?? "?"})`);
			} else {
				warn("paseo-daemon", "status returned but localDaemon field missing");
			}
		} catch {
			fail("paseo-daemon", "paseo status --json did not return JSON");
		}
	} else {
		fail("paseo-daemon", `daemon unreachable: ${status.error.slice(0, 160)}`);
	}
}

// --- claude code runtime ------------------------------------------------------
// The Pi extension check above covers the Pi runtime. These cover the Claude
// runtime, which is installed separately and is inert until a Paseo provider
// sets PASEO_CLAUDE_ROLE. Missing pieces WARN rather than FAIL: a Pi-only host
// is a legitimate configuration.

{
	const claudeDir = process.env.CLAUDE_TEAM_DIR ?? join(homedir(), ".claude", "paseo-team");
	const hookPath = join(claudeDir, "claude-team-hook.mjs");
	const required = ["claude-team-hook.mjs", "claude-policy.mts", "policy-core.mts"];
	const missing = required.filter((f) => !existsSync(join(claudeDir, f)));
	if (missing.length > 0) {
		warn("claude-runtime", `${claudeDir}: missing ${missing.join(", ")} → run scripts/install.{sh,ps1} for Claude Code roles`);
	} else {
		pass("claude-runtime", claudeDir);
	}

	// DEPLOYED-POLICY DRIFT. The checks above prove the runtime files EXIST.
	// They say nothing about which policy those files contain, and that gap is
	// occupied, not theoretical: measured 2026-09-01 on this pack's own host, the
	// deploy dir was missing seven support scripts and its hook carried none of
	// that day's gates, while every existing-file check passed clean. Agents had
	// been enforcing an older policy for an unknown length of time and nothing
	// said so.
	//
	// This compares the DEPLOYED manifest against this checkout's. A repo-only
	// digest check (`policy-digest.mjs --check`) cannot see this: it compares the
	// repo to its own manifest, and both sides move together on every commit.
	//
	// FAIL, not warn, and the severity is deliberate. A missing runtime is a
	// legitimate configuration (a Pi-only host), so that stays a warning. A
	// runtime that exists and disagrees is the hook firing with rules nobody in
	// this checkout reviewed — the same class as "the hook silently never fires",
	// which is already loud here.
	if (missing.length === 0) {
		const deployedManifest = join(claudeDir, "manifest.json");
		if (!existsSync(deployedManifest)) {
			fail("claude-policy-drift", `${claudeDir}: no manifest.json → the deployed policy cannot be attributed to any version. Re-run scripts/install.{sh,ps1}`);
		} else {
			try {
				const deployed = JSON.parse(readFileSync(deployedManifest, "utf8")).policyDigest;
				const here = policyDigest().policyDigest;
				if (deployed !== here) {
					fail("claude-policy-drift", `${claudeDir} runs ${deployed ?? "(no digest)"} but this checkout is ${here} → agents are enforcing a policy that is not the one here. Re-run scripts/install.{sh,ps1}`);
				} else {
					pass("claude-policy-drift", `deployed policy matches this checkout (${deployed})`);
				}
			} catch (error) {
				fail("claude-policy-drift", `${deployedManifest} is unreadable (${String(error?.message ?? error)}) → the deployed policy cannot be attributed`);
			}
		}
	}

	// The settings file is what the provider passes with --settings. A hook path
	// that does not resolve means the policy silently never fires, which is the
	// one failure mode worth being loud about.
	const settingsPath = join(claudeDir, "settings.claude-team.json");
	if (!existsSync(settingsPath)) {
		warn("claude-hooks", `${settingsPath} missing → Claude roles would run unpoliced`);
	} else {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			const events = Object.keys(settings.hooks ?? {});
			const wanted = ["SessionStart", "UserPromptSubmit", "PreToolUse", "SessionEnd"];
			const missingEvents = wanted.filter((e) => !events.includes(e));
			const commands = new Set(
				Object.values(settings.hooks ?? {})
					.flat()
					.flatMap((group) => (group.hooks ?? []).map((h) => h.command)),
			);
			const unresolved = [...commands].filter((c) => c && !existsSync(c));
			if (missingEvents.length > 0) {
				fail("claude-hooks", `${settingsPath}: missing hook events ${missingEvents.join(", ")}`);
			} else if (unresolved.length > 0) {
				fail("claude-hooks", `${settingsPath}: hook command does not exist: ${unresolved.join(", ")}`);
			} else if (!commands.has(hookPath)) {
				warn("claude-hooks", `${settingsPath} does not point at ${hookPath}`);
			} else {
				pass("claude-hooks", `${wanted.length} events → ${hookPath}`);
			}
		} catch (error) {
			fail("claude-hooks", `${settingsPath}: invalid JSON (${String(error?.message ?? error)})`);
		}
	}
}

// --- role providers + model inventory -----------------------------------------

const providersById = new Map();
if (daemonUp) {
	const ls = tryExec("paseo", ["provider", "ls", "--json"]);
	if (ls.ok) {
		try {
			const providers = JSON.parse(ls.stdout);
			for (const p of Array.isArray(providers) ? providers : []) {
				providersById.set(p.provider ?? p.id, p);
			}
		} catch {
			fail("role-providers", "paseo provider ls --json did not return JSON");
		}
		for (const role of ["claude-supervisor", "claude-lead", "claude-peer"]) {
			const entry = providersById.get(role);
			if (!entry)
				fail(`role-provider:${role}`, "not registered in ~/.paseo/config.json");
			else if (
				String(entry.enabled).toLowerCase() !== "enabled" &&
				entry.enabled !== true
			) {
				fail(`role-provider:${role}`, "registered but disabled");
			} else {
				// A provider can be enabled AND unhealthy — printing the status
				// next to a ✓ is a false pass. Reject the same statuses the
				// route resolver rejects.
				const status =
					typeof entry.status === "string" ? entry.status.toLowerCase() : null;
				if (status !== null && !PROVIDER_OK_STATUSES.has(status)) {
					fail(
						`role-provider:${role}`,
						`status "${entry.status}" is unhealthy (expected: ${[...PROVIDER_OK_STATUSES].join("/")})`,
					);
				} else {
					pass(`role-provider:${role}`, String(entry.status ?? "ok"));
				}
			}
		}
	} else {
		fail("role-providers", "could not list providers");
	}
}

const modelsCache = new Map();
function listModels(roleProvider) {
	if (modelsCache.has(roleProvider)) return modelsCache.get(roleProvider);
	const res = tryExec(
		"paseo",
		["provider", "models", roleProvider, "--json"],
		120000,
	);
	if (!res.ok) {
		modelsCache.set(roleProvider, null);
		return null;
	}
	try {
		const models = JSON.parse(res.stdout);
		modelsCache.set(roleProvider, models);
		return models;
	} catch {
		modelsCache.set(roleProvider, null);
		return null;
	}
}

// --- routing config + routes ---------------------------------------------------

const routesExplicit = process.argv.includes("--routes");
let routing = null;
if (!existsSync(routesPath)) {
	if (routesExplicit) {
		fail("routing-config", `${routesPath} (explicit --routes) does not exist`);
	} else {
		strictCheck(
			"routing-config",
			`${routesPath} missing (copy config/model-routing.example.json and edit). Routing checks skipped.`,
		);
	}
} else {
	try {
		routing = loadRoutingConfig(routesPath);
		pass("routing-config", `hostId=${routing.hostId}`);
	} catch (error) {
		if (error instanceof RoutingError) fail("routing-config", error.message);
		else fail("routing-config", String(error));
	}
}


if (routing && daemonUp && !skipModels) {
	for (const modelClass of MODEL_CLASSES) {
		const route = routing.routes[modelClass];
		const models = listModels(route.paseoProvider);
		if (models === null) {
			strictCheck(
				`route:${modelClass}`,
				`could not list models for ${route.paseoProvider} (daemon busy?)${wantStrict ? " — strict: unverifiable is not a pass" : ""}`,
			);
			continue;
		}
		// buildProviderInventory keeps `status` intact and the resolver runs
		// in strict mode when --strict was passed — an enabled-but-erroring
		// provider or an unverifiable thinking list must NOT be a pass.
		const inventory = {
			providers: buildProviderInventory([...providersById.values()]),
			models,
		};
		try {
			const resolved = resolveRoute(routing, modelClass, inventory, {
				strict: wantStrict,
			});
			// Per-model thinkingLevelMap guard (Paseo's list does not reflect it).
			{
				pass(
					`route:${modelClass}`,
					`${resolved.createAgentProvider} + thinking=${route.thinking}`,
				);
			}
		} catch (error) {
			if (error instanceof RoutingError)
				fail(`route:${modelClass}`, error.message);
			else fail(`route:${modelClass}`, String(error));
		}
	}
} else if (routing && skipModels) {
	warn("routes", "model inventory checks skipped (--skip-models)");
}

// --- legacy hosts.local.json migration notice ------------------------------------
// The N-host registry was replaced by the single controller-local cluster file.
// Removing the reader silently would leave a stale hosts.local.json looking
// authoritative while nothing read it, so say so once, loudly, instead.

if (existsSync(legacyHostsPath)) {
	warn(
		"hosts-config",
		`${legacyHostsPath} is a REMOVED legacy format and is ignored — move its entries into ${clusterPath} (see docs/multi-host.md) and delete the file`,
	);
}
if (process.argv.includes("--hosts")) {
	warn(
		"hosts-config",
		"--hosts was removed with the legacy host registry; pass --cluster <path> instead",
	);
}

// --- live remote preflight helpers ---------------------------------------------

/** Structural endpoint validation lives in model-routing.mjs so it can be
 * unit-tested: parse-based per scheme (offer URL / tcp:// with query params /
 * host:port), never a raw character whitelist. */
const isSafeEndpointValue = validateRemoteEndpoint;

/** Chars that can never appear in ANY argv element we quote for cmd.exe
 * (static literals are short ascii; endpoint values already passed the
 * stricter isSafeEndpointValue check). */
const UNSAFE_ARGV_RE = /[\s"'`<>|()[\]{}\\]/;

/** Quote one argv element for cmd.exe when NEEDS_SHELL joins the command. */
function cmdQuote(value) {
	if (UNSAFE_ARGV_RE.test(value)) {
		throw new Error(`refusing to pass unsafe argv value to shell`);
	}
	return `"${value}"`;
}
/** Run a paseo CLI command. On Windows (.cmd shims) every argv element is
 * quoted through cmdQuote; endpoint values carry secrets so they ONLY ever
 * travel inside argv — they are logged nowhere. */
function remoteExec(argv, timeoutMs = 60000) {
	if (NEEDS_SHELL) {
		return tryExecRaw(
			[argv[0], ...argv.slice(1).map(cmdQuote)].join(" "),
			timeoutMs,
		);
	}
	return tryExec(argv[0], argv.slice(1), timeoutMs);
}

function tryExecRaw(commandString, timeoutMs) {
	try {
		const stdout = execSync(commandString, {
			timeout: timeoutMs,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		return { ok: true, stdout };
	} catch (error) {
		return {
			ok: false,
			stdout: error?.stdout ? String(error.stdout) : "",
			error: String(error?.message ?? error),
		};
	}
}

const remoteModelsCache = new Map();
/**
 * Model inventory is per-DAEMON. The cache key must therefore carry the
 * host identity, never the role-provider name alone — two remote hosts
 * serving the same "claude-peer" provider do NOT share an inventory, and a
 * mixed cache would let a preflight pass on a model that only exists on
 * the other host.
 */
function listModelsRemote(hostId, endpointValue, roleProvider) {
	const key = modelsCacheKey(hostId, roleProvider);
	if (remoteModelsCache.has(key)) {
		return remoteModelsCache.get(key);
	}
	const res = remoteExec(
		[
			"paseo",
			"provider",
			"models",
			roleProvider,
			"--host",
			endpointValue,
			"--json",
		],
		120000,
	);
	let models = null;
	if (res.ok) {
		try {
			const parsed = JSON.parse(res.stdout);
			models = Array.isArray(parsed) ? parsed : (parsed?.models ?? null);
		} catch {
			models = null;
		}
	}
	remoteModelsCache.set(key, models);
	return models;
}

function runRemotePreflight(hostId, host, endpointValue) {
	// 1. daemon reachable?
	const reach = remoteExec(["paseo", "ls", "--host", endpointValue, "--json"]);
	if (!reach.ok) {
		fail(
			`cluster-remote:${hostId}`,
			`remote daemon unreachable via ${host.connection.endpointEnv}: ${String(reach.error).slice(0, 120)}`,
		);
		return;
	}
	pass(`cluster-remote:${hostId}`, "remote daemon reachable (offer accepted)");

	// 2. role providers present + enabled + healthy on the remote daemon.
	const ls = remoteExec([
		"paseo",
		"provider",
		"ls",
		"--host",
		endpointValue,
		"--json",
	]);
	const remoteProviders = new Map();
	if (ls.ok) {
		try {
			for (const p of JSON.parse(ls.stdout)) {
				remoteProviders.set(p.provider ?? p.id, p);
			}
		} catch {
			fail(
				`cluster-remote:${hostId}:providers`,
				"provider ls --json unparseable",
			);
			return;
		}
	} else {
		fail(
			`cluster-remote:${hostId}:providers`,
			"could not list remote providers",
		);
		return;
	}
	const neededProviders = new Set(
		Object.values(host.routes).map((r) => r.paseoProvider),
	);
	for (const roleProvider of neededProviders) {
		const entry = remoteProviders.get(roleProvider);
		const status = String(entry?.status ?? "").toLowerCase();
		const enabled =
			entry?.enabled === true ||
			String(entry?.enabled ?? "").toLowerCase() === "enabled";
		if (!entry) {
			fail(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				"role provider NOT registered on remote daemon",
			);
		} else if (!enabled || !PROVIDER_OK_STATUSES.has(status)) {
			fail(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				`status="${entry.status}" enabled=${entry.enabled} (need enabled + healthy status: ${[...PROVIDER_OK_STATUSES].join("/")})`,
			);
		} else {
			pass(
				`cluster-remote:${hostId}:provider:${roleProvider}`,
				"enabled + healthy",
			);
		}
	}

	// 3. Route resolution against the REMOTE inventory.
	const inventoryProviders = buildProviderInventory([
		...remoteProviders.values(),
	]);
	for (const modelClass of MODEL_CLASSES) {
		const route = host.routes[modelClass];
		const models = listModelsRemote(hostId, endpointValue, route.paseoProvider);
		if (models === null) {
			strictCheck(
				`cluster-remote:${hostId}:route:${modelClass}`,
				`could not list models for ${route.paseoProvider} on remote`,
			);
			continue;
		}
		try {
			const resolved = resolveClusterRoute(
				cluster,
				hostId,
				modelClass,
				{ providers: inventoryProviders, models },
				{ strict: wantStrict },
			);
			pass(
				`cluster-remote:${hostId}:route:${modelClass}`,
				resolved.createAgentProvider,
			);
		} catch (error) {
			fail(
				`cluster-remote:${hostId}:route:${modelClass}`,
				error instanceof RoutingError ? error.message : String(error),
			);
		}
	}
}

// The repo-clean writer gate must use the host that was actually selected
// for verification (possibly inferred), not only an explicit --host-id.
let clusterVerifyHostId;

// --- cluster routing contract (controller-local) ------------------------------

// In strict mode the cluster contract file is REQUIRED (missing → exit 1).
// Otherwise absence only warns so single-host dev setups keep working.
let cluster = null;
if (existsSync(clusterPath)) {
	try {
		cluster = loadClusterConfig(clusterPath);
		pass(
			"cluster-config",
			`${Object.keys(cluster.hosts).length} host(s): ${Object.keys(cluster.hosts).join(", ")}`,
		);
	} catch (error) {
		fail(
			"cluster-config",
			error instanceof RoutingError ? error.message : String(error),
		);
	}
} else if (clusterExplicit || wantStrict) {
	fail("cluster-config", `${clusterPath} missing (required in strict mode)`);
} else {
	warn(
		"cluster-config",
		`${clusterPath} missing (copy config/cluster-routing.example.json; required for cross-host routing)`,
	);
}

if (cluster) {
	for (const [hostId, host] of Object.entries(cluster.hosts)) {
		// Required remote hosts must have their endpoint env present; the VALUE
		// is never read or printed — only name-based presence is checked.
		if (host.connection.type === "remote" && host.required) {
			const envName = host.connection.endpointEnv;
			if (envName && process.env[envName]) {
				pass(
					`cluster-host:${hostId}`,
					`endpoint env ${envName} present (value not printed)`,
				);
			} else {
				strictCheck(
					`cluster-host:${hostId}`,
					`required remote host but endpoint env ${envName ?? "<missing endpointEnv>"} NOT set`,
				);
			}
		}
		// Capability contract: a host that claims review roles must not also be
		// a writer; writer hosts must carry the writer capabilities.
		if (host.limits.writers > 0) {
			const missing = missingHostCapabilities(host, "writer");
			if (missing.length > 0) {
				fail(
					`cluster-host:${hostId}`,
					`declares writers=${host.limits.writers} but lacks writer capabilities: ${missing.join(", ")}`,
				);
			}
		}
	}

	// Resolve the route for the host this preflight was asked to verify.
	// Verify targets a single host: --host-id, or the only host when the
	// cluster has exactly one. Nothing is ever verified silently — every
	// skip produces an explicit result line.
	const verifyHostId =
		hostIdArg ??
		(Object.keys(cluster.hosts).length === 1
			? Object.keys(cluster.hosts)[0]
			: undefined);
	if (!hostIdArg && verifyHostId === undefined && wantStrict) {
		fail(
			"cluster-host-select",
			"multiple hosts in cluster config; strict preflight requires --host-id <id>",
		);
	} else if (!hostIdArg && verifyHostId === undefined) {
		warn(
			"cluster-host-select",
			`multiple hosts in cluster config (${Object.keys(cluster.hosts).join(", ")}); no per-host route verification performed — pass --host-id <id>`,
		);
	}
	clusterVerifyHostId = verifyHostId;
	if (verifyHostId !== undefined) {
		const host = cluster.hosts[verifyHostId];
		if (!host) {
			fail(
				`cluster-host:${verifyHostId}`,
				`--host-id "${verifyHostId}" not present in cluster routing config`,
			);
		} else if (host.connection.type === "local" && skipModels) {
			warn(
				`cluster-route:${verifyHostId}`,
				"local route verification skipped (--skip-models)",
			);
		} else if (host.connection.type === "local" && daemonUp && !skipModels) {
			// Local host: full route resolution against the live daemon, strict.
			for (const modelClass of MODEL_CLASSES) {
				const route = host.routes[modelClass];
				const models = listModels(route.paseoProvider);
				if (models === null) {
					strictCheck(
						`cluster-route:${verifyHostId}:${modelClass}`,
						`could not list models for ${route.paseoProvider}`,
					);
					continue;
				}
				const inventory = {
					providers: buildProviderInventory([...providersById.values()]),
					models,
				};
				try {
					const resolved = resolveClusterRoute(
						cluster,
						verifyHostId,
						modelClass,
						inventory,
						{ strict: wantStrict },
					);
					pass(
						`cluster-route:${verifyHostId}:${modelClass}`,
						resolved.createAgentProvider,
					);
				} catch (error) {
					fail(
						`cluster-route:${verifyHostId}:${modelClass}`,
						error instanceof RoutingError ? error.message : String(error),
					);
				}
			}
		} else if (host.connection.type === "remote") {
			// Remote host: if the endpoint env is set AND the value passes a
			// strict shape check, perform a LIVE remote preflight via the Paseo
			// CLI (the offer URL / tcp endpoint is accepted as --host). The
			// endpoint value is never logged.
			const envName = host.connection.endpointEnv;
			const envValue = envName ? process.env[envName] : undefined;
			if (!envValue) {
				strictCheck(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName ?? "<missing>"} NOT set — live remote preflight skipped`,
				);
			} else if (!isSafeEndpointValue(envValue)) {
				fail(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName} has an unexpected shape (expected paseo offer URL or tcp:// target) — refusing to use it`,
				);
			} else if (NEEDS_SHELL && cmdPercentExpansionRisk(envValue)) {
				// cmd.exe expands %VAR% before paseo sees the argv — the endpoint
				// would be silently corrupted or leak into expansions. Fail loudly
				// rather than trying to out-quote cmd's parser.
				fail(
					`cluster-remote:${verifyHostId}`,
					`endpoint env ${envName} contains 2+ '%' characters — unsafe with cmd.exe %VAR% expansion on Windows controllers (use a pairing offer URL or a non-cmd controller)`,
				);
			} else if (skipModels) {
				warn(
					`cluster-remote:${verifyHostId}`,
					"endpoint set but --skip-models active — remote inventory checks skipped",
				);
			} else {
				runRemotePreflight(verifyHostId, host, envValue);
			}
		} else if (!daemonUp) {
			strictCheck(
				`cluster-host:${verifyHostId}`,
				"local daemon down — cluster route resolution skipped",
			);
		}
	}
}

// --- repository state (if run inside a repo) ------------------------------------

{
	const repo = tryExec("git", ["rev-parse", "--is-inside-work-tree"]);
	if (repo.ok && repo.stdout.trim() === "true") {
		const status = tryExec("git", ["status", "--porcelain"]);
		if (status.ok && status.stdout.trim() === "") {
			pass("repo-clean", "working tree clean");
		} else if (status.ok) {
			const dirtyWriter =
				clusterVerifyHostId !== undefined &&
				cluster !== null &&
				cluster.hosts[clusterVerifyHostId] &&
				cluster.hosts[clusterVerifyHostId].limits.writers > 0;
			if (dirtyWriter) {
				strictCheck(
					"repo-clean",
					`writer host "${clusterVerifyHostId}" has uncommitted changes — writer workspaces must start clean`,
				);
			} else if (status.ok) {
				warn(
					"repo-clean",
					"uncommitted changes present (user-owned changes must never be overwritten by agents)",
				);
			}
		}
	}
}

if (wantJson) {
	let digestReceipt = null;
	try {
		const digest = policyDigest();
		digestReceipt = { version: digest.version, policyDigest: digest.policyDigest };
	} catch { /* digest failure is reported as null, never fabricated */ }
	console.log(
		JSON.stringify(
			{ checks: results, ok: !results.some((r) => r.status === "fail"), policy: digestReceipt },
			null,
			2,
		),
	);
}
process.exit(summarizeMessages());
