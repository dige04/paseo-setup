import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStaleAgents,
  collectDailyReconciliation,
  DEFAULT_GLOBAL_DEADLINE_MS,
  DEFAULT_INSPECT_CONCURRENCY,
  parseWatchdogOptions,
} from "../scripts/watchdog.mjs";

const now = Date.parse("2026-08-08T12:00:00.000Z");
const result = classifyStaleAgents(
  [
    { id: "old", status: "running", updatedAt: "2026-08-08T11:50:00.000Z", inspectOk: true },
    { id: "recent", status: "running", updatedAt: "2026-08-08T11:59:50.000Z", inspectOk: true },
    { id: "idle", status: "idle", updatedAt: "2026-08-08T10:00:00.000Z" },
    { id: "invalid", status: "running", updatedAt: "not-a-date", inspectOk: true },
    { id: "unreachable", status: "running", updatedAt: "2026-08-08T11:00:00.000Z", inspectOk: false },
  ],
  { now, staleAfterMs: 5 * 60_000 },
);
assert.deepEqual(result.map((agent) => agent.id), ["old", "recent", "invalid", "unreachable"]);
assert.equal(result.find((agent) => agent.id === "old").stale, true);
assert.equal(result.find((agent) => agent.id === "recent").stale, false);
assert.equal(result.find((agent) => agent.id === "invalid").confidence, "unknown");
assert.equal(result.find((agent) => agent.id === "invalid").stale, false);
assert.equal(result.find((agent) => agent.id === "unreachable").confidence, "unknown");
assert.equal(result.find((agent) => agent.id === "unreachable").stale, false);
assert.equal(DEFAULT_INSPECT_CONCURRENCY, 6);
assert.equal(DEFAULT_GLOBAL_DEADLINE_MS, 30_000);

{
  let active = 0;
  let peak = 0;
  const result = await (await import("../scripts/watchdog.mjs")).collectWatchdogSnapshot({
    concurrency: 2,
    globalDeadlineMs: 2_000,
    commandTimeoutMs: 500,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") {
        return Array.from({ length: 6 }, (_, index) => ({ id: `agent-${index}`, status: "running" }));
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { Status: "running", UpdatedAt: "2026-08-08T11:00:00.000Z", PendingPermissions: [] };
    },
    now,
  });
  assert.equal(peak, 2, "watchdog inspect concurrency is bounded");
  assert.equal(result.agents.length, 6);
  assert.equal(result.partial, false);

  const capped = await (await import("../scripts/watchdog.mjs")).collectWatchdogSnapshot({
    maxAgents: 2,
    globalDeadlineMs: 2_000,
    commandTimeoutMs: 500,
    maxAttempts: 1,
    runPaseoJson: async (args) => args[0] === "ls"
      ? Array.from({ length: 3 }, (_, index) => ({ id: `agent-${index}`, status: "running" }))
      : { Status: "running", UpdatedAt: "2026-08-08T11:00:00.000Z", PendingPermissions: [] },
    now,
  });
  assert.equal(capped.agents.length, 2);
  assert.equal(capped.partial, true, "maxAgents cap is reported as partial");
}

assert.deepEqual(parseWatchdogOptions(undefined), {});
assert.equal(parseWatchdogOptions('{"mode":"daily-reconcile"}').mode, "daily-reconcile");
assert.throws(() => parseWatchdogOptions("[]"), /expected an object/);
assert.throws(() => parseWatchdogOptions('{"mode":"archive-now"}'), /invalid watchdog mode/);

{
  const paseoHome = mkdtempSync(join(tmpdir(), "paseo-reconcile-"));
  const cwd = join(paseoHome, "worktrees", "bucket", "task");
  mkdirSync(cwd, { recursive: true });
  const calls = [];
  const old = "2026-08-01T00:00:00.000Z";
  const runPaseoJson = async (args) => {
    calls.push(args);
    if (args[0] === "daemon") return { daemonVersion: "0.6.1" };
    if (args[0] === "inspect") {
      return { Archived: true, Status: "idle", UpdatedAt: old, PendingPermissions: [] };
    }
    if (args[0] === "workspace") {
      return [{ workspaceId: "wks-1", project: "demo", name: "task", isolation: "worktree", cwd }];
    }
    if (args[0] === "terminal") return [];
    if (args[0] === "ls" && args.includes("harness.retention=keep")) return [];
    if (args[0] === "ls" && args.includes("-a")) {
      return [{ id: "agent-1", cwd, status: "idle", created: old }];
    }
    if (args[0] === "ls") return [];
    throw new Error(`unexpected paseo args: ${args.join(" ")}`);
  };
  const runGit = async (_path, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "", error: null };
    if (command === "rev-parse --show-toplevel") return { code: 0, stdout: `${cwd}\n`, stderr: "", error: null };
    if (command === "rev-parse --git-dir --git-common-dir") {
      // Linked-worktree shape: git-dir differs from git-common-dir.
      return { code: 0, stdout: `${cwd}/.git\n/tmp/parent-repo/.git\n`, stderr: "", error: null };
    }
    if (command.startsWith("status ")) return { code: 0, stdout: "", stderr: "", error: null };
    if (command.startsWith("ls-files --others --ignored")) return { code: 0, stdout: "", stderr: "", error: null };
    if (command === "symbolic-ref --quiet --short HEAD") return { code: 0, stdout: "agent/T-1\n", stderr: "", error: null };
    if (command === "rev-parse HEAD") return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "", error: null };
    if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", error: null };
    if (command.startsWith("branch -r --contains")) return { code: 0, stdout: "origin/main\n", stderr: "", error: null };
    if (command.startsWith("merge-base --is-ancestor")) return { code: 0, stdout: "", stderr: "", error: null };
    return { code: 1, stdout: "", stderr: "unexpected git call", error: "unexpected git call" };
  };
  const report = await collectDailyReconciliation({
    project: "demo",
    paseoHome,
    retireAfterMs: 60_000,
    now,
    runPaseoJson,
    runGit,
    runProcessProbe: async () => ({ code: 1, signal: null, stdout: "", stderr: "", error: "Command failed: lsof" }),
  });
  assert.equal(report.schema, "paseo.team-reconcile/v1");
  assert.equal(report.mutates, false);
  assert.equal(report.workspaces.candidates.length, 1);
  assert.equal(report.workspaces.candidates[0].workspaceId, "wks-1");
  assert.ok(calls.some((args) => args.includes("harness.owner=paseo-claude-team")));
  assert.ok(calls.some((args) => args.includes("harness.project=demo")));
  assert.ok(calls.some((args) => args[0] === "terminal" && args.includes("--all")));

  const keepInventoryFailed = await collectDailyReconciliation({
    project: "demo",
    paseoHome,
    retireAfterMs: 60_000,
    now,
    runPaseoJson: async (args) => {
      if (args.includes("harness.retention=keep")) throw new Error("selector unavailable");
      return runPaseoJson(args);
    },
    runGit,
    runProcessProbe: async () => ({ code: 1, signal: null, stdout: "", stderr: "", error: "Command failed: lsof" }),
  });
  assert.equal(keepInventoryFailed.workspaces.candidates.length, 0);
  assert.ok(
    keepInventoryFailed.workspaces.refused[0].blockers.some((item) => item.code === "retention_unknown"),
    "a failed keep-label query must veto cleanup rather than silently treating every agent as ephemeral",
  );

  const retentionMissing = await collectDailyReconciliation({
    project: "demo",
    paseoHome,
    retireAfterMs: 60_000,
    now,
    runPaseoJson: async (args) => {
      if (args.includes("harness.retention=keep") || args.includes("harness.retention=ephemeral")) return [];
      return runPaseoJson(args);
    },
    runGit,
    runProcessProbe: async () => ({ code: 1, signal: null, stdout: "", stderr: "", error: "Command failed: lsof" }),
  });
  assert.equal(retentionMissing.workspaces.candidates.length, 0);
  assert.ok(retentionMissing.workspaces.refused[0].blockers.some((item) => item.code === "retention_unknown"));

  const malformedTerminalInventory = await collectDailyReconciliation({
    project: "demo",
    paseoHome,
    retireAfterMs: 60_000,
    now,
    runPaseoJson: async (args) => args[0] === "terminal" ? {} : runPaseoJson(args),
    runGit,
    runProcessProbe: async () => ({ code: 1, signal: null, stdout: "", stderr: "", error: "Command failed: lsof" }),
  });
  assert.equal(malformedTerminalInventory.sources.terminals.ok, false);
  assert.equal(malformedTerminalInventory.workspaces.candidates.length, 0);
}

console.log("watchdog tests passed");
