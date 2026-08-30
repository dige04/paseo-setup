import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_RETIRE_AFTER_MS,
  buildReconciliationReport,
  classifyOrphanWorktree,
  classifyWorkspaceRetirement,
  isPathInside,
} from "./reconcile-core.mjs";
// Both moved to lib-common.mjs when governance-graph.mjs became the second
// consumer of agent-scope identity; re-exported because this module was their
// published home and test/reconcile-core.mjs imports normalizePaseoCwd here.
import { normalizePaseoCwd, resolveCanonicalCwds } from "./lib-common.mjs";

export { normalizePaseoCwd, resolveCanonicalCwds };

export const DEFAULT_MANAGED_LABELS = Object.freeze([
  "harness.owner=paseo-claude-team",
]);
export const DEFAULT_MAX_MANAGED_AGENTS = 200;
export const DEFAULT_MAX_ORPHANS = 20;
export const DEFAULT_INSPECT_CONCURRENCY = 6;
export const SUPPORTED_PASEO_VERSION = "0.6.1";

function valueOf(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined) return record[key];
  }
  return undefined;
}

function normalizeStatus(value) {
  return String(value ?? "unknown").trim().toLowerCase();
}

function validateLabelSelector(label) {
  if (typeof label !== "string" || label.length > 256 || !/^[A-Za-z0-9_.-]+=[^=\r\n]+$/.test(label)) {
    throw new Error(`invalid managed label selector ${JSON.stringify(label)}; expected key=value`);
  }
  return label;
}

function boundedNumber(name, raw, fallback, min, max) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function validateBaseRef(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("baseRef must be a Git ref string");
  const ref = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(ref) || !ref.includes("/") || ref.includes("..") || ref.includes("//")) {
    throw new Error(`invalid baseRef ${JSON.stringify(raw)}`);
  }
  return ref;
}

export function normalizeReconcileOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("daily-reconcile options must be an object");
  }
  const managedLabels = options.managedLabels ?? DEFAULT_MANAGED_LABELS;
  if (!Array.isArray(managedLabels) || managedLabels.length === 0 || managedLabels.length > 8) {
    throw new Error("managedLabels must contain 1..8 key=value selectors");
  }
  const normalizedManagedLabels = managedLabels.map(validateLabelSelector);
  if (normalizedManagedLabels.some((label) => /^(?:harness\.retention|harness\.project)=/.test(label))) {
    throw new Error("managedLabels must not select harness.retention or harness.project; both are separate safety selectors");
  }
  const project = typeof options.project === "string" && options.project.trim() ? options.project.trim() : null;
  if (project !== null && !/^[A-Za-z0-9_.-]{1,128}$/.test(project)) {
    throw new Error("project must be a label-safe Paseo project id");
  }
  return {
    project,
    managedLabels: normalizedManagedLabels,
    retireAfterMs: boundedNumber("retireAfterMs", options.retireAfterMs, DEFAULT_RETIRE_AFTER_MS, 60_000, 365 * 24 * 60 * 60_000),
    maxManagedAgents: boundedNumber("maxManagedAgents", options.maxManagedAgents, DEFAULT_MAX_MANAGED_AGENTS, 1, 1000),
    maxOrphans: boundedNumber("maxOrphans", options.maxOrphans, DEFAULT_MAX_ORPHANS, 0, 200),
    inspectConcurrency: boundedNumber("inspectConcurrency", options.inspectConcurrency, DEFAULT_INSPECT_CONCURRENCY, 1, 16),
    includeOrphans: options.includeOrphans === true,
    probeProcesses: options.probeProcesses !== false,
    commandTimeoutMs: boundedNumber("commandTimeoutMs", options.commandTimeoutMs, 5000, 250, 30_000),
    baseRef: validateBaseRef(options.baseRef),
    paseoHome: resolve(typeof options.paseoHome === "string" && options.paseoHome.trim()
      ? options.paseoHome.trim()
      : process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo")),
  };
}

export function runFile(command, args, options = {}) {
  return new Promise((resolveResult) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 5000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }, (error, stdout, stderr) => {
      // `code` is the real exit status or null when the process never exited
      // normally (timeout signal, spawn failure). Callers that fail closed on
      // `code !== 0` keep that behavior; nothing may treat null as an exit code.
      resolveResult({
        code: error
          ? (typeof error.code === "number" ? error.code : error.code === "ENOENT" ? 127 : null)
          : 0,
        signal: error?.signal ?? null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        error: error ? String(error.message ?? error) : null,
      });
    });
  });
}

async function gitResult(cwd, args, options) {
  const runner = options.runGit ?? ((path, argv) => runFile("git", ["-C", path, ...argv], {
    timeoutMs: options.commandTimeoutMs,
  }));
  return runner(cwd, args);
}

export async function inspectGitWorktree(cwd, options = {}) {
  const inside = await gitResult(cwd, ["rev-parse", "--is-inside-work-tree"], options);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, error: inside.error ?? (inside.stderr.trim() || "not a Git worktree") };
  }
  const [topLevelResult, gitDirsResult, statusResult, ignoredResult, branchResult, headResult, defaultBaseResult, remoteResult] = await Promise.all([
    gitResult(cwd, ["rev-parse", "--show-toplevel"], options),
    gitResult(cwd, ["rev-parse", "--git-dir", "--git-common-dir"], options),
    gitResult(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], options),
    gitResult(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard"], options),
    gitResult(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], options),
    gitResult(cwd, ["rev-parse", "HEAD"], options),
    options.baseRef
      ? Promise.resolve({ code: 0, stdout: `${options.baseRef}\n`, stderr: "", error: null })
      : gitResult(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], options),
    gitResult(cwd, ["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"], options),
  ]);
  if ([topLevelResult, gitDirsResult, statusResult, ignoredResult, headResult].some((result) => result.code !== 0)) {
    return { ok: false, error: "required Git evidence could not be read" };
  }
  // Both sides must be realpath'd: `cwd` may reach here via a symlinked
  // spelling while `--show-toplevel` reports git's own (possibly different)
  // resolved form. Lexical resolve() alone cannot detect that they name the
  // same directory.
  let realCwd;
  let realTopLevel;
  try {
    [realCwd, realTopLevel] = await Promise.all([
      realpath(cwd),
      realpath(topLevelResult.stdout.trim()),
    ]);
  } catch (error) {
    return { ok: false, error: `worktree path could not be canonicalized: ${String(error?.message ?? error)}` };
  }
  if (realTopLevel !== realCwd) {
    return { ok: false, error: "candidate path is not the Git worktree top level" };
  }
  // A standalone clone has --git-dir === --git-common-dir; only a LINKED
  // worktree (whose common dir lives in the parent repository) may ever be
  // proposed for removal — a clone can hold branches with unpushed work that
  // per-branch evidence on HEAD alone cannot see.
  const gitDirLines = gitDirsResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const linkedWorktree = gitDirLines.length === 2
    ? resolve(cwd, gitDirLines[0]) !== resolve(cwd, gitDirLines[1])
    : false;
  const rawBase = defaultBaseResult.code === 0 ? defaultBaseResult.stdout.trim() : "";
  const baseRef = rawBase.replace(/^refs\/remotes\//, "") || null;
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null;
  let mergedIntoBase = false;
  const baseTargetsCurrentBranch = Boolean(branch && baseRef && baseRef.split("/").slice(1).join("/") === branch);
  if (baseRef && !baseTargetsCurrentBranch) {
    const merged = await gitResult(cwd, ["merge-base", "--is-ancestor", "HEAD", baseRef], options);
    mergedIntoBase = merged.code === 0;
  }
  return {
    ok: true,
    linkedWorktree,
    clean: statusResult.stdout.length === 0,
    ignoredFiles: ignoredResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort(),
    branch,
    head: headResult.stdout.trim() || null,
    baseRef,
    mergedIntoBase,
    baseTargetsCurrentBranch,
    remoteRefs: remoteResult.code === 0
      ? remoteResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort()
      : [],
    remoteObservation: "local remote-tracking refs; no fetch performed",
  };
}

export async function inspectProcessUse(cwd, options = {}) {
  if (options.probeProcesses === false) return { state: "unknown", error: "process probe disabled" };
  if (process.platform === "win32" && !options.runProcessProbe) {
    return { state: "unknown", error: "process probe unsupported on win32" };
  }
  // Deliberately NO -w: lsof's "can't opendir" warning on an unsearchable
  // subdirectory is exactly the evidence that occupants below it are invisible.
  // Suppressing it converts "I could not look" into "nothing there" — the
  // adversarial verifier reproduced a live occupant under a mode-000 subdir
  // reading `clear` with -w, and `unknown` without it.
  const runner = options.runProcessProbe ?? ((path) => runFile("lsof", ["+D", path, "-Fn"], {
    timeoutMs: options.commandTimeoutMs,
  }));
  const result = await runner(cwd);
  // lsof exits 1 both when it finds nothing and (on macOS, with unsearchable
  // subdirectories) when it finds occupants, so the exit code alone carries no
  // signal. Occupancy is read from stdout unconditionally; `clear` additionally
  // requires a real exit (timeouts and spawn failures have code null) with no
  // residual output on either stream.
  const pids = String(result.stdout ?? "").split(/\r?\n/)
    .filter((line) => /^p\d+$/.test(line))
    .map((line) => Number(line.slice(1)))
    .filter(Number.isFinite);
  if (pids.length > 0) return { state: "in-use", pids: [...new Set(pids)].sort((a, b) => a - b) };
  if ((result.code === 0 || result.code === 1)
    && result.signal == null
    && String(result.stdout ?? "").trim() === ""
    && String(result.stderr ?? "").trim() === "") {
    return { state: "clear" };
  }
  return { state: "unknown", error: result.error ?? (String(result.stderr ?? "").trim() || `lsof exited ${result.code}`) };
}

function attachCanonicalCwd(record, canonicalMap) {
  const entry = record.cwd ? canonicalMap.get(record.cwd) : undefined;
  return { ...record, canonicalCwd: entry && entry.canonical !== null ? entry.canonical : null };
}

/**
 * Managed agents additionally surface a canonicalization miss as an
 * inspection failure (F014-class fail-closed evidence) so it lands in the
 * report's agents.cannotVerify list without reconcile-core.mjs needing a new
 * blocker code.
 */
function attachAgentCanonicalCwd(agent, canonicalMap) {
  const entry = agent.cwd ? canonicalMap.get(agent.cwd) : undefined;
  const canonicalCwd = entry && entry.canonical !== null ? entry.canonical : null;
  const cwdUnresolved = Boolean(agent.cwd) && canonicalCwd === null;
  if (!cwdUnresolved || agent.inspectOk !== true) {
    return { ...agent, canonicalCwd };
  }
  return {
    ...agent,
    canonicalCwd,
    inspectOk: false,
    inspectError: `cwd could not be canonicalized: ${entry?.error ?? "unresolved"}`,
  };
}

function compactAgent(raw) {
  const cwd = normalizePaseoCwd(valueOf(raw, "cwd", "Cwd"));
  return {
    id: String(valueOf(raw, "id", "Id") ?? ""),
    cwd,
    status: normalizeStatus(valueOf(raw, "status", "Status")),
    updatedAt: valueOf(raw, "updatedAt", "UpdatedAt", "created", "CreatedAt") ?? null,
  };
}

function inspectedAgent(summary, detail, keepIds, ephemeralIds, retentionKnown, inspectError = null) {
  const inspectedCwd = compactAgent({ cwd: valueOf(detail, "Cwd", "cwd") ?? summary.cwd }).cwd;
  const keep = keepIds.has(summary.id);
  const ephemeral = ephemeralIds.has(summary.id);
  const rawPending = valueOf(detail, "PendingPermissions", "pendingPermissions");
  const detailSchemaOk = detail !== null && typeof detail === "object" && Array.isArray(rawPending);
  const effectiveInspectError = inspectError ?? (detailSchemaOk ? null : "inspect returned an invalid PendingPermissions payload");
  return {
    ...summary,
    cwd: inspectedCwd,
    status: normalizeStatus(valueOf(detail, "Status", "status") ?? summary.status),
    updatedAt: valueOf(detail, "UpdatedAt", "updatedAt") ?? summary.updatedAt,
    archived: valueOf(detail, "Archived", "archived") === true,
    pendingPermissions: detailSchemaOk ? rawPending : [],
    retention: retentionKnown && keep !== ephemeral ? (keep ? "keep" : "ephemeral") : "unknown",
    inspectOk: effectiveInspectError === null,
    ...(effectiveInspectError === null ? {} : { inspectError: effectiveInspectError }),
  };
}

function terminalSummary(raw) {
  return {
    id: String(valueOf(raw, "terminalId", "id", "Id") ?? ""),
    workspaceId: valueOf(raw, "workspaceId", "WorkspaceId") ?? null,
    cwd: normalizePaseoCwd(valueOf(raw, "cwd", "Cwd")),
  };
}

async function sourceArray(sources, name, operation) {
  try {
    const value = await operation();
    if (!Array.isArray(value)) throw new Error(`${name} returned a non-array payload`);
    sources[name] = { ok: true, count: value.length };
    return value;
  } catch (error) {
    sources[name] = { ok: false, count: null, error: String(error?.message ?? error) };
    return [];
  }
}

async function sourceObject(sources, name, operation) {
  try {
    const value = await operation();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${name} returned a non-object payload`);
    }
    sources[name] = { ok: true };
    return value;
  } catch (error) {
    sources[name] = { ok: false, error: String(error?.message ?? error) };
    return {};
  }
}

function markMalformedSource(sources, name, records, validator) {
  const malformed = records.filter((record) => !validator(record)).length;
  if (malformed === 0) return;
  sources[name] = {
    ok: false,
    count: records.length,
    error: `${name} contained ${malformed} malformed record(s)`,
  };
}

async function mapWithConcurrency(items, concurrency, operation) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

/**
 * `rawCwd` is only used for the lstat symlink veto; every path comparison
 * consumes the precomputed canonical cwd/root (resolveCanonicalCwds output
 * and the once-per-run canonical worktree root) — never a fresh realpath.
 */
async function canonicalOwnership(rawCwd, canonicalCwd, canonicalRoot) {
  try {
    const entry = await lstat(rawCwd);
    if (entry.isSymbolicLink()) return { owned: false, realCwd: null, error: "worktree path is a symlink" };
  } catch (error) {
    return { owned: false, realCwd: null, error: String(error?.message ?? error) };
  }
  if (!canonicalCwd || !canonicalRoot) {
    return {
      owned: false,
      realCwd: null,
      error: canonicalRoot ? "worktree cwd could not be canonicalized" : "worktree root could not be canonicalized",
    };
  }
  return { owned: isPathInside(canonicalRoot, canonicalCwd), realCwd: canonicalCwd, realRoot: canonicalRoot };
}

/** `canonicalCwd` and every `agents[].canonicalCwd` must already be resolved by the caller. */
function agentsUnder(canonicalCwd, agents) {
  if (!canonicalCwd) return [];
  return agents.filter((agent) => agent.canonicalCwd && isPathInside(canonicalCwd, agent.canonicalCwd));
}

/** `workspaceId` may be falsy (orphan lane), in which case only cwd containment applies. */
function terminalsUnder(workspaceId, canonicalCwd, terminals) {
  return terminals.filter((terminal) =>
    (workspaceId && terminal.workspaceId === workspaceId)
    || (canonicalCwd && terminal.canonicalCwd && isPathInside(canonicalCwd, terminal.canonicalCwd)));
}

function newestAgeMs(agents, now, fallbackMtimeMs) {
  const timestamps = agents.map((agent) => Date.parse(agent.updatedAt ?? "")).filter(Number.isFinite);
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : fallbackMtimeMs;
  return Number.isFinite(newest) ? Math.max(0, now - newest) : null;
}

/**
 * `worktreeRoot` must already be the once-per-run canonical root and
 * `activeCanonicalCwds` must already be canonical. Because symlinks are
 * skipped at both directory levels below, every joined `path` is canonical
 * by construction — this function performs zero realpath calls of its own.
 */
async function listOrphanDirectories(worktreeRoot, activeCanonicalCwds, maxOrphans, rotationSeed, keepPath) {
  if (maxOrphans <= 0) return { paths: [], total: 0, cursor: 0 };
  const out = [];
  let buckets;
  try { buckets = await readdir(worktreeRoot, { withFileTypes: true }); }
  catch { return { paths: [], total: 0, cursor: 0 }; }
  for (const bucket of buckets.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) continue;
    let entries;
    try { entries = await readdir(join(worktreeRoot, bucket.name), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(worktreeRoot, bucket.name, entry.name);
      if (activeCanonicalCwds.includes(path)) continue;
      // Scope filtering must happen BEFORE the rotation window, or a run scoped
      // to one project has its window diluted by other projects' orphans.
      if (keepPath && !keepPath(path)) continue;
      out.push(path);
    }
  }
  if (out.length <= maxOrphans) return { paths: out, total: out.length, cursor: 0 };
  const cursor = Math.abs(rotationSeed) % out.length;
  const rotated = [...out.slice(cursor), ...out.slice(0, cursor)].slice(0, maxOrphans);
  return { paths: rotated, total: out.length, cursor };
}

export async function collectDailyReconciliation(rawOptions = {}) {
  const options = normalizeReconcileOptions(rawOptions);
  // worktreeRoot is realpath'd exactly once per run, right here. worktreeRootRaw
  // stays literal for the report's scope field; worktreeRootCanonical is the
  // sole root value comparison sites (ownership, orphan scan) ever see.
  const worktreeRootRaw = join(options.paseoHome, "worktrees");
  let worktreeRootCanonical = null;
  let worktreeRootError = null;
  try {
    worktreeRootCanonical = await realpath(worktreeRootRaw);
  } catch (error) {
    worktreeRootError = String(error?.message ?? error);
  }
  const now = Number.isFinite(rawOptions.now) ? rawOptions.now : Date.now();
  const generatedAt = new Date(now).toISOString();
  const sources = {};
  const paseoJson = rawOptions.runPaseoJson;
  if (typeof paseoJson !== "function") throw new Error("collectDailyReconciliation requires runPaseoJson");
  const ownershipSelectors = [
    ...options.managedLabels,
    ...(options.project ? [`harness.project=${options.project}`] : []),
  ];
  const labelArgs = ownershipSelectors.flatMap((label) => ["--label", label]);

  let nativeAutoArchiveAfterMerge = null;
  try {
    const config = JSON.parse(await readFile(join(options.paseoHome, "config.json"), "utf8"));
    nativeAutoArchiveAfterMerge = config?.daemon?.autoArchiveAfterMerge === true;
    sources.nativeAutoArchiveAfterMerge = {
      ok: true,
      enabled: nativeAutoArchiveAfterMerge,
      assessment: "informational only; Paseo 0.6.1 native cleanup is not treated as positive closure evidence",
    };
  } catch (error) {
    sources.nativeAutoArchiveAfterMerge = {
      ok: false,
      enabled: null,
      error: String(error?.message ?? error),
    };
  }

  const [daemonRaw, activeRaw, managedRaw, keepRaw, ephemeralRaw, workspacesRaw, terminalsRaw] = await Promise.all([
    sourceObject(sources, "daemon", () => paseoJson(["daemon", "status"], options.commandTimeoutMs)),
    sourceArray(sources, "activeAgents", () => paseoJson(["ls", "-g"], options.commandTimeoutMs)),
    sourceArray(sources, "managedAgents", () => paseoJson(["ls", "-g", "-a", ...labelArgs], options.commandTimeoutMs)),
    sourceArray(sources, "keepAgents", () => paseoJson([
      "ls", "-g", "-a", ...labelArgs, "--label", "harness.retention=keep",
    ], options.commandTimeoutMs)),
    sourceArray(sources, "ephemeralAgents", () => paseoJson([
      "ls", "-g", "-a", ...labelArgs, "--label", "harness.retention=ephemeral",
    ], options.commandTimeoutMs)),
    sourceArray(sources, "workspaces", () => paseoJson(["workspace", "ls"], options.commandTimeoutMs)),
    sourceArray(sources, "terminals", () => paseoJson(["terminal", "ls", "--all"], options.commandTimeoutMs)),
  ]);

  const paseoVersion = typeof valueOf(daemonRaw, "daemonVersion", "DaemonVersion") === "string"
    ? valueOf(daemonRaw, "daemonVersion", "DaemonVersion")
    : null;
  const paseoVersionStatus = paseoVersion === SUPPORTED_PASEO_VERSION
    ? "supported"
    : paseoVersion === null ? "unknown" : "unsupported";
  sources.daemon = {
    ...sources.daemon,
    version: paseoVersion,
    supportedVersion: SUPPORTED_PASEO_VERSION,
    versionStatus: paseoVersionStatus,
  };

  markMalformedSource(sources, "activeAgents", activeRaw, (raw) => compactAgent(raw).id && compactAgent(raw).cwd);
  markMalformedSource(sources, "managedAgents", managedRaw, (raw) => compactAgent(raw).id && compactAgent(raw).cwd);
  markMalformedSource(sources, "keepAgents", keepRaw, (raw) => Boolean(compactAgent(raw).id));
  markMalformedSource(sources, "ephemeralAgents", ephemeralRaw, (raw) => Boolean(compactAgent(raw).id));
  markMalformedSource(sources, "workspaces", workspacesRaw, (raw) =>
    Boolean(valueOf(raw, "workspaceId", "WorkspaceId") && valueOf(raw, "cwd", "Cwd") && valueOf(raw, "isolation", "Isolation")));
  markMalformedSource(sources, "terminals", terminalsRaw, (raw) =>
    Boolean(valueOf(raw, "terminalId", "id", "Id") && (valueOf(raw, "workspaceId", "WorkspaceId") || valueOf(raw, "cwd", "Cwd"))));

  const activeAgentsLocal = (Array.isArray(activeRaw) ? activeRaw : []).map(compactAgent).filter((agent) => agent.id);
  const managedSummaries = (Array.isArray(managedRaw) ? managedRaw : []).map(compactAgent).filter((agent) => agent.id);
  const keepIds = new Set((Array.isArray(keepRaw) ? keepRaw : []).map((raw) => compactAgent(raw).id));
  const ephemeralIds = new Set((Array.isArray(ephemeralRaw) ? ephemeralRaw : []).map((raw) => compactAgent(raw).id));
  const retentionKnown = sources.keepAgents.ok === true && sources.ephemeralAgents.ok === true;
  const inspectLimit = Math.min(options.maxManagedAgents, managedSummaries.length);
  const inspectedLocal = await mapWithConcurrency(managedSummaries, options.inspectConcurrency, async (agent, index) => {
    if (index >= inspectLimit) return inspectedAgent(agent, null, keepIds, ephemeralIds, retentionKnown, "managed-agent inspection cap reached");
    try {
      const detail = await paseoJson(["inspect", agent.id], options.commandTimeoutMs);
      return inspectedAgent(agent, detail, keepIds, ephemeralIds, retentionKnown);
    } catch (error) {
      return inspectedAgent(agent, null, keepIds, ephemeralIds, retentionKnown, String(error?.message ?? error));
    }
  });

  const managedIds = new Set(managedSummaries.map((agent) => agent.id));
  const terminalsLocal = (Array.isArray(terminalsRaw) ? terminalsRaw : []).map(terminalSummary);
  const workspacesLocal = (Array.isArray(workspacesRaw) ? workspacesRaw : []).map((raw) => ({
    workspaceId: String(valueOf(raw, "workspaceId", "WorkspaceId") ?? ""),
    project: String(valueOf(raw, "project", "Project") ?? ""),
    name: String(valueOf(raw, "name", "Name") ?? ""),
    isolation: String(valueOf(raw, "isolation", "Isolation") ?? ""),
    cwd: normalizePaseoCwd(valueOf(raw, "cwd", "Cwd")),
  })).filter((workspace) => workspace.workspaceId && workspace.cwd);

  // Ingest-time ownership: every cross-source path comparison below consumes
  // one of these canonicalized collections, never a raw agent/workspace/
  // terminal cwd string directly.
  const canonicalCwdMap = await resolveCanonicalCwds([
    ...activeAgentsLocal.map((agent) => agent.cwd),
    ...inspectedLocal.map((agent) => agent.cwd),
    ...workspacesLocal.map((workspace) => workspace.cwd),
    ...terminalsLocal.map((terminal) => terminal.cwd),
  ], { concurrency: options.inspectConcurrency });

  const activeAgents = activeAgentsLocal.map((agent) => attachCanonicalCwd(agent, canonicalCwdMap));
  const inspected = inspectedLocal.map((agent) => attachAgentCanonicalCwd(agent, canonicalCwdMap));
  const terminals = terminalsLocal.map((terminal) => attachCanonicalCwd(terminal, canonicalCwdMap));
  const workspaces = workspacesLocal.map((workspace) => attachCanonicalCwd(workspace, canonicalCwdMap));

  sources.inspections = {
    ok: inspected.every((agent) => agent.inspectOk),
    count: inspectLimit,
    capped: managedSummaries.length > inspectLimit,
  };

  const classifiedWorkspaces = [];
  for (const workspace of workspaces) {
    const managedHistory = agentsUnder(workspace.canonicalCwd, inspected);
    if (options.project && workspace.project !== options.project) continue;
    if (!options.project && managedHistory.length === 0) continue;
    const activeUnder = agentsUnder(workspace.canonicalCwd, activeAgents);
    const ownership = await canonicalOwnership(workspace.cwd, workspace.canonicalCwd, worktreeRootCanonical);
    let fallbackMtimeMs = NaN;
    try { fallbackMtimeMs = (await stat(workspace.cwd)).mtimeMs; } catch { /* classified unknown elsewhere */ }
    const processUse = sources.activeAgents.ok && sources.managedAgents.ok && sources.workspaces.ok && sources.terminals.ok
      ? await inspectProcessUse(workspace.cwd, { ...rawOptions, ...options })
      : { state: "unknown", error: "agent, workspace, or terminal inventory unavailable" };
    const git = await inspectGitWorktree(workspace.cwd, { ...rawOptions, ...options });
    classifiedWorkspaces.push(classifyWorkspaceRetirement({
      ...workspace,
      paseoOwned: ownership.owned,
      paseoVersion,
      paseoVersionStatus,
      managedAgents: managedHistory,
      activeAgents: activeUnder.filter((agent) => managedIds.has(agent.id)).map((agent) => agent.id),
      foreignActiveAgents: activeUnder.filter((agent) => !managedIds.has(agent.id)).map((agent) => agent.id),
      sharedWorkspaceIds: workspaces
        .filter((candidate) => workspace.canonicalCwd && candidate.canonicalCwd === workspace.canonicalCwd)
        .map((candidate) => candidate.workspaceId)
        .sort(),
      terminals: terminalsUnder(workspace.workspaceId, workspace.canonicalCwd, terminals).map((terminal) => terminal.id || terminal.workspaceId),
      processUse,
      git,
      ageMs: newestAgeMs(managedHistory, now, fallbackMtimeMs),
    }, options));
  }

  const classifiedOrphans = [];
  if (options.includeOrphans && sources.workspaces.ok && sources.activeAgents.ok && sources.managedAgents.ok) {
    if (worktreeRootCanonical === null) {
      sources.orphanScan = {
        ok: false,
        count: 0,
        error: worktreeRootError ?? "worktree root could not be canonicalized",
      };
    } else {
      const activeCanonicalCwds = workspaces.map((workspace) => workspace.canonicalCwd).filter(Boolean);
      const orphanWindow = await listOrphanDirectories(
        worktreeRootCanonical,
        activeCanonicalCwds,
        options.maxOrphans,
        Math.floor(now / (24 * 60 * 60_000)),
        options.project ? (path) => agentsUnder(path, inspected).length > 0 : null,
      );
      for (const cwd of orphanWindow.paths) {
        // `cwd` here is already canonical by construction (see
        // listOrphanDirectories); it is passed as both the raw and the
        // canonical argument below, matching that guarantee.
        const managedHistory = agentsUnder(cwd, inspected);
        const ownership = await canonicalOwnership(cwd, cwd, worktreeRootCanonical);
        const activeUnder = agentsUnder(cwd, activeAgents);
        const terminalUnder = terminalsUnder(null, cwd, terminals);
        const processUse = sources.terminals.ok
          ? await inspectProcessUse(cwd, { ...rawOptions, ...options })
          : { state: "unknown", error: "terminal inventory unavailable" };
        const git = await inspectGitWorktree(cwd, { ...rawOptions, ...options });
        let fallbackMtimeMs = NaN;
        try { fallbackMtimeMs = (await stat(cwd)).mtimeMs; } catch { /* unknown */ }
        classifiedOrphans.push(classifyOrphanWorktree({
          cwd,
          paseoOwned: ownership.owned,
          paseoVersion,
          paseoVersionStatus,
          managedAgents: managedHistory,
          activeAgents: activeUnder.map((agent) => agent.id),
          terminals: terminalUnder.map((terminal) => terminal.id),
          processUse,
          git,
          ageMs: newestAgeMs(managedHistory, now, fallbackMtimeMs),
        }, options));
      }
      sources.orphanScan = {
        ok: true,
        count: classifiedOrphans.length,
        totalDiscovered: orphanWindow.total,
        windowCount: orphanWindow.paths.length,
        capped: orphanWindow.total > orphanWindow.paths.length,
        cursor: orphanWindow.cursor,
      };
    }
  } else {
    sources.orphanScan = {
      ok: !options.includeOrphans,
      count: 0,
      skipped: !options.includeOrphans ? "disabled" : "required inventory unavailable",
    };
  }

  return buildReconciliationReport({
    generatedAt,
    scope: {
      project: options.project,
      managedLabels: ownershipSelectors,
      retireAfterMs: options.retireAfterMs,
      includeOrphans: options.includeOrphans,
      worktreeRoot: worktreeRootRaw,
      nativeAutoArchiveAfterMerge,
      paseoVersion,
      paseoVersionStatus,
    },
    sources,
    agents: {
      managed: inspected.length,
      archived: inspected.filter((agent) => agent.archived).map((agent) => agent.id).sort(),
      active: inspected.filter((agent) => !agent.archived).map((agent) => agent.id).sort(),
      attention: inspected.filter((agent) => agent.pendingPermissions.length > 0).map((agent) => agent.id).sort(),
      cannotVerify: inspected.filter((agent) => !agent.inspectOk).map((agent) => agent.id).sort(),
    },
    workspaces: classifiedWorkspaces,
    orphans: classifiedOrphans,
  });
}
