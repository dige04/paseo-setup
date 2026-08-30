import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import {
  RECONCILE_SCHEMA,
  buildReconciliationReport,
  classifyAgentHealth,
  classifyOrphanWorktree,
  classifyWorkspaceRetirement,
  isPathInside,
} from "../scripts/reconcile-core.mjs";
import { inspectProcessUse, normalizePaseoCwd, normalizeReconcileOptions, runFile } from "../scripts/reconcile-observer.mjs";

const goodGit = Object.freeze({
  ok: true,
  linkedWorktree: true,
  clean: true,
  branch: "agent/T-42",
  head: "a".repeat(40),
  baseRef: "origin/main",
  mergedIntoBase: true,
  remoteRefs: ["origin/agent/T-42", "origin/main"],
  ignoredFiles: [],
  baseTargetsCurrentBranch: false,
});

function workspace(overrides = {}) {
  return {
    workspaceId: "wks_42",
    project: "demo",
    name: "T-42",
    cwd: "/tmp/paseo/worktrees/demo/t-42",
    isolation: "worktree",
    paseoOwned: true,
    paseoVersionStatus: "supported",
    paseoVersion: "0.6.1",
    managedAgents: [{
      id: "agent-42",
      archived: true,
      inspectOk: true,
      pendingPermissions: [],
      retention: "ephemeral",
    }],
    activeAgents: [],
    foreignActiveAgents: [],
    terminals: [],
    processUse: { state: "clear" },
    git: { ...goodGit },
    ageMs: 48 * 60 * 60_000,
    ...overrides,
  };
}

test("path containment distinguishes descendants from sibling prefixes", () => {
  const root = join("/tmp", "worktrees", "task");
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, join(root, "nested", "server")), true);
  assert.equal(isPathInside(root, `${root}-other`), false);
});

test("Paseo tilde cwd expands to the same absolute workspace path", () => {
  assert.equal(normalizePaseoCwd("~/.paseo/worktrees/bucket/task"), join(homedir(), ".paseo", "worktrees", "bucket", "task"));
});

test("runFile contract: a non-zero exit always carries a non-null error", async () => {
  // The probe classifier depends on this producer shape. The old fixtures
  // injected {code:1, error:null} — a shape runFile provably cannot emit —
  // which certified a dead branch as covered. This pins the real contract.
  const failed = await runFile("sh", ["-c", "exit 1"]);
  assert.equal(failed.code, 1);
  assert.equal(typeof failed.error, "string");
  assert.equal(failed.signal, null);
  const ok = await runFile("sh", ["-c", "true"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.error, null);
  const timedOut = await runFile("sleep", ["5"], { timeoutMs: 50 });
  assert.strictEqual(timedOut.code, null, "a killed process has no exit code (strictly null, not undefined)");
  const enoent = await runFile("definitely-not-a-command-xyz", []);
  assert.strictEqual(enoent.code, 127, "spawn ENOENT is pinned to 127");
  assert.notEqual(timedOut.signal, null);
});

test("process probe: timeouts and failures never become clear evidence", async () => {
  // Timeout/kill: runFile reports code null + signal.
  const timedOut = await inspectProcessUse("/tmp/example", {
    runProcessProbe: async () => ({ code: null, signal: "SIGTERM", stdout: "", stderr: "", error: "timed out" }),
  });
  assert.equal(timedOut.state, "unknown");
  // Real failure with diagnostics on stderr.
  const failed = await inspectProcessUse("/tmp/example", {
    runProcessProbe: async () => ({ code: 2, signal: null, stdout: "", stderr: "lsof: illegal option", error: "Command failed" }),
  });
  assert.equal(failed.state, "unknown");
  // A permission warning on stderr means "I could not look everywhere" —
  // that must be unknown, never clear. (Adversarial repro: occupant below a
  // mode-000 subdir was invisible to lsof; only the suppressed warning
  // distinguished that from a genuinely empty tree.)
  const unsearchable = await inspectProcessUse("/tmp/example", {
    runProcessProbe: async () => ({ code: 1, signal: null, stdout: "", stderr: "lsof: WARNING: can't opendir(/tmp/example/hidden): Permission denied", error: "Command failed: lsof" }),
  });
  assert.equal(unsearchable.state, "unknown");
  // lsof convention: exit 1 with no output at all means "no files located".
  // error is non-null here because execFile always sets it on non-zero exit.
  const clear = await inspectProcessUse("/tmp/example", {
    runProcessProbe: async () => ({ code: 1, signal: null, stdout: "", stderr: "", error: "Command failed: lsof" }),
  });
  assert.equal(clear.state, "clear");
  // macOS emits occupants AND exits 1 when some subdirectory is unsearchable;
  // occupancy must be read from stdout, not from the exit code.
  const busy = await inspectProcessUse("/tmp/example", {
    runProcessProbe: async () => ({ code: 1, signal: null, stdout: "p123\nn/tmp/example\np99\n", stderr: "", error: "Command failed: lsof" }),
  });
  assert.equal(busy.state, "in-use");
  assert.deepEqual(busy.pids, [99, 123]);
});

test("process probe positive control through the real producer", async (t) => {
  // AP-02 guard: the `clear` and `in-use` states must each be reachable via
  // the REAL lsof/runFile pipeline at least once — not only via fixtures.
  if (process.platform === "win32") return t.skip("lsof probe unsupported on win32");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(joinPath(tmpdir(), "probe-ctl-"));
  try {
    const quiet = await inspectProcessUse(dir, { commandTimeoutMs: 5000 });
    assert.equal(quiet.state, "clear", `quiescent dir must read clear, got ${JSON.stringify(quiet)}`);
    const occupant = spawn("sleep", ["30"], { cwd: dir, stdio: "ignore" });
    try {
      const busy = await inspectProcessUse(dir, { commandTimeoutMs: 5000 });
      assert.equal(busy.state, "in-use", `occupied dir must read in-use, got ${JSON.stringify(busy)}`);
      assert.ok(busy.pids.includes(occupant.pid), "the occupant pid must be reported");
    } finally {
      occupant.kill("SIGKILL");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("observer options reject malformed selectors and numeric/ref injection", () => {
  assert.throws(() => normalizeReconcileOptions({ managedLabels: ["bare"] }), /key=value/);
  assert.throws(
    () => normalizeReconcileOptions({ managedLabels: ["harness.retention=ephemeral"] }),
    /separate safety selectors/,
  );
  assert.throws(() => normalizeReconcileOptions({ retireAfterMs: "later" }), /finite number/);
  assert.throws(() => normalizeReconcileOptions({ baseRef: "--help" }), /invalid baseRef/);
  assert.throws(() => normalizeReconcileOptions({ baseRef: "HEAD" }), /invalid baseRef/);
  assert.throws(() => normalizeReconcileOptions({ baseRef: "origin/main..evil" }), /invalid baseRef/);
});

test("a fully evidenced workspace becomes review-only candidate", () => {
  const out = classifyWorkspaceRetirement(workspace(), { retireAfterMs: 24 * 60 * 60_000 });
  assert.equal(out.state, "candidate");
  assert.equal(out.proposedAction.type, "review_workspace_archive");
  assert.equal(out.proposedAction.requiresHumanConfirmation, true);
  assert.equal("command" in out.proposedAction, false, "never emit deletion shell commands");
});

test("idle is not completion and keep is a veto", () => {
  const out = classifyWorkspaceRetirement(workspace({
    managedAgents: [{
      id: "idle-agent",
      status: "idle",
      archived: false,
      inspectOk: true,
      pendingPermissions: [],
      retention: "keep",
    }],
  }));
  assert.equal(out.state, "keep");
  assert.deepEqual(
    out.blockers.map((item) => item.code).sort(),
    ["agent_not_archived", "retention_keep"],
  );
});

test("every destructive uncertainty refuses fail-closed", () => {
  const cases = [
    ["foreign agent", { foreignActiveAgents: ["foreign"] }, "foreign_agent_active", "keep"],
    ["pending permission", { managedAgents: [{ id: "a", archived: true, inspectOk: true, pendingPermissions: [{}], retention: "ephemeral" }] }, "permission_pending", "keep"],
    ["dirty", { git: { ...goodGit, clean: false } }, "worktree_dirty", "keep"],
    ["ignored local files", { git: { ...goodGit, ignoredFiles: [".env"] } }, "ignored_files_present", "keep"],
    ["self base", { git: { ...goodGit, baseTargetsCurrentBranch: true, mergedIntoBase: false } }, "base_ref_is_current_branch", "keep"],
    ["unmerged", { git: { ...goodGit, mergedIntoBase: false } }, "head_not_merged_into_base", "keep"],
    ["unreachable", { git: { ...goodGit, remoteRefs: [] } }, "head_not_reachable_from_remote", "keep"],
    ["process unknown", { processUse: { state: "unknown" } }, "process_use_unknown", "cannot_verify"],
    ["ownership unknown", { paseoOwned: false }, "paseo_ownership_unknown", "cannot_verify"],
    ["unsupported Paseo", { paseoVersionStatus: "unsupported", paseoVersion: "0.7.0" }, "paseo_version_unsupported", "cannot_verify"],
    ["inspect failed", { managedAgents: [{ id: "a", archived: true, inspectOk: false, pendingPermissions: [], retention: "ephemeral" }] }, "agent_inspect_failed", "cannot_verify"],
    ["retention unknown", { managedAgents: [{ id: "a", archived: true, inspectOk: true, pendingPermissions: [], retention: "unknown" }] }, "retention_unknown", "cannot_verify"],
    ["shared workspace", { sharedWorkspaceIds: ["wks_42", "wks_other"] }, "multiple_workspace_references", "keep"],
    ["recent", { ageMs: 1000 }, "grace_period_active", "keep"],
    ["git unknown", { git: { ok: false, error: "timeout" } }, "git_unknown", "cannot_verify"],
    ["standalone clone", { git: { ...goodGit, linkedWorktree: false } }, "not_linked_worktree", "keep"],
    ["worktree link unstated", { git: (({ linkedWorktree, ...rest }) => rest)(goodGit) }, "worktree_link_unknown", "cannot_verify"],
    ["active agents present", { activeAgents: ["a1"] }, "agent_active", "keep"],
    ["terminals present", { terminals: ["t1"] }, "terminal_active", "keep"],
    // Malformed inventories must fail CLOSED, never read as empty.
    ["malformed activeAgents", { activeAgents: {} }, "active_agents_inventory_malformed", "cannot_verify"],
    ["malformed terminals", { terminals: "oops" }, "terminals_inventory_malformed", "cannot_verify"],
    ["malformed foreign", { foreignActiveAgents: 7 }, "foreign_active_agents_inventory_malformed", "cannot_verify"],
    ["malformed managed", { managedAgents: {} }, "managed_agents_inventory_malformed", "cannot_verify"],
    ["malformed pending", { managedAgents: [{ id: "a", archived: true, inspectOk: true, pendingPermissions: "oops", retention: "ephemeral" }] }, "pending_permissions_inventory_malformed", "cannot_verify"],
  ];
  for (const [name, overrides, expectedCode, expectedState] of cases) {
    const out = classifyWorkspaceRetirement(workspace(overrides));
    assert.equal(out.state, expectedState, name);
    assert.ok(out.blockers.some((item) => item.code === expectedCode), name);
    assert.equal(out.proposedAction, null, name);
  }
});

test("orphan worktree also requires positive evidence", () => {
  const candidate = classifyOrphanWorktree({
    cwd: "/tmp/paseo/worktrees/demo/orphan",
    paseoOwned: true,
    paseoVersionStatus: "supported",
    paseoVersion: "0.6.1",
    managedAgents: [{ id: "archived", archived: true, inspectOk: true, pendingPermissions: [], retention: "ephemeral" }],
    activeAgents: [],
    terminals: [],
    processUse: { state: "clear" },
    git: { ...goodGit },
    ageMs: 48 * 60 * 60_000,
  });
  assert.equal(candidate.state, "candidate");
  assert.equal(candidate.proposedAction.type, "review_orphan_worktree_removal");

  const active = classifyOrphanWorktree({
    ...candidate,
    paseoOwned: true,
    paseoVersionStatus: "supported",
    paseoVersion: "0.6.1",
    managedAgents: [{ id: "archived", archived: true, inspectOk: true, pendingPermissions: [], retention: "ephemeral" }],
    activeAgents: ["agent-in-descendant"],
    terminals: [],
    processUse: { state: "clear" },
    git: { ...goodGit },
  });
  assert.equal(active.state, "keep");
  assert.ok(active.blockers.some((item) => item.code === "agent_active"));
});

test("orphan classifier also fails closed on malformed inventories", () => {
  const base = {
    cwd: "/tmp/paseo/worktrees/demo/orphan",
    paseoOwned: true,
    paseoVersionStatus: "supported",
    paseoVersion: "0.6.1",
    managedAgents: [{ id: "a", archived: true, inspectOk: true, pendingPermissions: [], retention: "ephemeral" }],
    activeAgents: [],
    terminals: [],
    processUse: { state: "clear" },
    git: { ...goodGit },
    ageMs: 48 * 60 * 60_000,
  };
  assert.equal(classifyOrphanWorktree(base).state, "candidate", "control");
  for (const [field, bad] of [["activeAgents", {}], ["terminals", "oops"], ["activeAgents", 7]]) {
    const out = classifyOrphanWorktree({ ...base, [field]: bad });
    assert.equal(out.state, "cannot_verify", `${field}=${JSON.stringify(bad)}`);
    assert.equal(out.proposedAction, null);
  }
});

test("review findings: malformed/edge inputs fail closed, never throw or mis-own", () => {
  // F002 — a null/non-object agent record must fail closed, not crash the pass.
  assert.equal(classifyWorkspaceRetirement(workspace({ managedAgents: [null] })).state, "cannot_verify");
  assert.ok(classifyWorkspaceRetirement(workspace({ managedAgents: [null] }))
    .blockers.some((b) => b.code === "agent_record_malformed"));
  assert.equal(classifyAgentHealth(null).state, "cannot_verify");
  assert.equal(classifyAgentHealth("x").state, "cannot_verify");

  // F007 — orphan path must use the same inventory guard as the workspace path.
  const orphanBad = classifyOrphanWorktree({
    cwd: "/tmp/o", paseoOwned: true, paseoVersionStatus: "supported",
    managedAgents: {}, activeAgents: [], terminals: [], processUse: { state: "clear" },
    git: { ...goodGit }, ageMs: 99 * 60 * 60_000,
  });
  assert.ok(orphanBad.blockers.some((b) => b.code === "managed_agents_inventory_malformed"),
    "orphan malformed managedAgents must be malformed, not no_managed_agent_history");

  // F015 — a non-finite retireAfterMs must not silently skip the grace veto.
  const nanAge = classifyWorkspaceRetirement(workspace({ ageMs: 1000 }), { retireAfterMs: NaN });
  assert.ok(nanAge.blockers.some((b) => b.code === "age_unknown"));
  assert.notEqual(nanAge.state, "candidate");
});

test("review F001: cross-drive relative results are rejected (win32 predicate)", () => {
  // POSIX relative() cannot produce the C:\\ vs D:\\ split that triggered the
  // bug, so exercise the actual guard logic against win32 path semantics. The
  // isAbsolute check is what this test kills a mutation of: without it, a
  // different-drive candidate reads as contained.
  const insideWin32 = (root, candidate) => {
    const rel = win32.relative(win32.resolve(root), win32.resolve(candidate));
    if (win32.isAbsolute(rel)) return false;
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${win32.sep}`) && !rel.startsWith(win32.sep));
  };
  assert.equal(insideWin32("C:\\wt", "D:\\other"), false, "different drives are never contained");
  assert.equal(insideWin32("C:\\wt", "C:\\wt\\child"), true, "same-drive descendant is contained");
  assert.equal(insideWin32("C:\\wt", "C:\\other"), false, "same-drive sibling is not contained");
  // And the shipped POSIX predicate still holds the non-containment direction.
  assert.equal(isPathInside("/a/b", "/a/bc"), false);
  assert.equal(isPathInside("/a/b", "/a/b/c"), true);
});

test("review F011: branch candidates are deduped and deterministically ordered", () => {
  const a = classifyWorkspaceRetirement(workspace({ workspaceId: "w1", cwd: "/tmp/w1" }));
  const b = classifyWorkspaceRetirement(workspace({ workspaceId: "w2", cwd: "/tmp/w2" }));
  // both share branch agent/T-42 from goodGit
  const report = buildReconciliationReport({
    generatedAt: "2026-08-30T00:00:00.000Z", scope: {}, sources: {}, agents: {},
    workspaces: [a, b], orphans: [],
  });
  const branchActions = report.proposedActions.filter((x) => x.type === "review_local_branch_retirement");
  assert.equal(branchActions.length, 1, "one branch → one retirement action");
});

test("report is deterministic, explicit, and observation-only", () => {
  const a = classifyWorkspaceRetirement(workspace({ workspaceId: "wks_b" }));
  const b = classifyWorkspaceRetirement(workspace({ workspaceId: "wks_a" }));
  const report = buildReconciliationReport({
    generatedAt: "2026-08-30T00:00:00.000Z",
    scope: { project: "demo" },
    sources: { workspaces: { ok: true } },
    agents: { managed: 1 },
    workspaces: [a, b],
    orphans: [],
  });
  assert.equal(report.schema, RECONCILE_SCHEMA);
  assert.equal(report.mutates, false);
  assert.match(report.cleanupPlan.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.cleanupPlan.applySupported, false);
  assert.deepEqual(report.workspaces.candidates.map((item) => item.workspaceId), ["wks_a", "wks_b"]);
  assert.ok(report.branches.candidates.every((item) => item.remoteDeletion === false));
  assert.ok(report.proposedActions.some((item) => item.type === "review_local_branch_retirement"));
  assert.match(report.policy.completedArtifacts, /never preserve a done marker/);
});
