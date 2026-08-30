import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDailyReconciliation } from "../scripts/reconcile-observer.mjs";

// AP-02 positive control, end-to-end. A fail-closed system whose positive
// branch is unreachable is externally indistinguishable from one that is
// correctly refusing — so the allowed state must be reached at least once
// through the REAL producers. Here git, lsof, and the filesystem are real;
// only the Paseo CLI inventories are injected (shapes captured from a live
// daemon, tilde-free realpath form).
//
// Positive control: a quiescent, merged, remote-reachable linked worktree with
// one archived ephemeral managed agent must classify `candidate`.
// Negative control: the SAME directory with a live process cwd'd inside must
// flip to `keep` with a CONFIRMED process_cwd_active blocker carrying that pid
// — not to `cannot_verify`. That is what proves the probe discriminates.

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("qualification: positive and negative control through real producers", { timeout: 60_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("lsof probe unsupported on win32");
  const root = await realpath(await mkdtemp(join(tmpdir(), "recon-qual-")));
  try {
    const parent = join(root, "parent");
    const home = join(root, "paseo-home");
    const wt = join(home, "worktrees", "bkt", "t-99");
    execFileSync("git", ["init", "-q", "-b", "main", parent]);
    git(parent, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    git(parent, "worktree", "add", "-q", "-b", "agent/T-99", wt, "main");
    await writeFile(join(wt, "file.txt"), "work\n");
    git(wt, "add", ".");
    git(wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "T-99 work");
    git(parent, "merge", "-q", "agent/T-99");
    execFileSync("git", ["clone", "-q", "--bare", parent, join(root, "origin.git")]);
    git(parent, "remote", "add", "origin", join(root, "origin.git"));
    git(parent, "fetch", "-q", "origin");
    const head = git(wt, "rev-parse", "HEAD");

    const now = Date.now();
    const agent = { id: "agent-99", cwd: wt, status: "closed", updatedAt: new Date(now - 48 * 3600e3).toISOString() };
    const runPaseoJson = async (args) => {
      const a = args.join(" ");
      if (a.startsWith("workspace ls")) return [{ workspaceId: "wks-99", project: "demo", name: "t-99", isolation: "worktree", cwd: wt }];
      if (a.includes("harness.retention=keep")) return [];
      if (a.includes("harness.retention=ephemeral")) return [agent];
      if (a.startsWith("ls -g -a")) return [agent];
      if (a.startsWith("ls -g")) return [];
      if (a.startsWith("terminal ls")) return [];
      if (a.startsWith("inspect")) return { Id: "agent-99", Cwd: wt, Archived: true, PendingPermissions: [] };
      if (a.startsWith("daemon status")) return { daemonVersion: "0.6.1" };
      throw new Error(`unmocked paseo call: ${a}`);
    };
    const run = () => collectDailyReconciliation({
      project: "demo", paseoHome: home, retireAfterMs: 60_000, includeOrphans: false,
      now, runPaseoJson, baseRef: "origin/main", commandTimeoutMs: 10_000,
    });

    const positive = await run();
    assert.equal(positive.mutates, false);
    assert.equal(positive.cleanupPlan.applySupported, false);
    assert.equal(positive.summary.candidates, 1,
      `positive control must reach candidate; refused: ${JSON.stringify(positive.workspaces.refused.map((w) => w.blockers))}`);
    const candidate = positive.workspaces.candidates[0];
    assert.equal(candidate.proposedAction.type, "review_workspace_archive");
    assert.equal(candidate.proposedAction.expectedHead, head);
    assert.equal(candidate.proposedAction.requiresHumanConfirmation, true);

    const occupant = spawn("sleep", ["30"], { cwd: wt, stdio: "ignore" });
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      const negative = await run();
      assert.equal(negative.summary.candidates, 0);
      const kept = negative.workspaces.refused[0];
      assert.equal(kept.state, "keep", "an occupied worktree must be a confirmed keep, not cannot_verify");
      const processBlocker = kept.blockers.find((item) => item.code === "process_cwd_active");
      assert.ok(processBlocker, "process_cwd_active must be present");
      assert.equal(processBlocker.certainty, "confirmed");
      assert.ok(processBlocker.details.includes(occupant.pid), "the occupant pid must be in the evidence");
    } finally {
      occupant.kill("SIGKILL");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// F014 positive control: the same logical worktree must correlate across two
// distinct cwd spellings — one reaching the classifier as a workspace cwd via
// an ancestor symlink, the other as an agent cwd already realpath'd. Before
// the canonicalization fix this fails two ways, both empirically confirmed by
// temporarily reverting agentsUnder/terminalsUnder to raw-cwd lexical form
// while leaving the git-toplevel realpath fix in place and re-running just
// this test: agentsUnder's lexical isPathInside saw no relationship between
// the spellings, refusing with `no_managed_agent_history` (unknown); and
// separately, inspectGitWorktree's pre-fix lexical resolve() toplevel check
// sees git's realpath'd --show-toplevel answer as a mismatch against the
// symlinked cwd, refusing with `git_unknown`. Both collapse to cannot_verify,
// never candidate — this test proves the fix reaches candidate instead, and
// that the negative control (an occupant under the symlinked spelling) still
// flips to keep.
//
// Phases 3-5 extend this same fixture (one git worktree, reused across every
// phase) to close mutation gaps a reviewer found: no fixture exercised the
// terminalsUnder cwd-containment branch (site 3) or the orphan/active dedup
// (site 5, FAIL-OPEN severity — a raw-cwd regression there lets an active
// worktree get reported as its own orphan-removal candidate). Site 6
// (sharedWorkspaceIds) is included as a cheap residual-risk-tier addition.
test("qualification F014: divergent cwd spellings still correlate", { timeout: 60_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("lsof probe unsupported on win32");
  const outerRoot = await realpath(await mkdtemp(join(tmpdir(), "recon-qual-div-")));
  try {
    const real = join(outerRoot, "real");
    const link = join(outerRoot, "link");
    const link2 = join(outerRoot, "link2");
    await mkdir(real, { recursive: true });
    await symlink(real, link, "dir");
    await symlink(real, link2, "dir");

    const parent = join(real, "parent");
    const home = join(link, "paseo-home");
    const home2 = join(link2, "paseo-home");
    const realWt = join(real, "paseo-home", "worktrees", "bkt", "t-div-99");
    const linkWt = join(home, "worktrees", "bkt", "t-div-99");
    const link2Wt = join(home2, "worktrees", "bkt", "t-div-99");

    execFileSync("git", ["init", "-q", "-b", "main", parent]);
    git(parent, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    git(parent, "worktree", "add", "-q", "-b", "agent/T-div-99", realWt, "main");
    await writeFile(join(realWt, "file.txt"), "work\n");
    git(realWt, "add", ".");
    git(realWt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "T-div-99 work");
    git(parent, "merge", "-q", "agent/T-div-99");
    execFileSync("git", ["clone", "-q", "--bare", parent, join(outerRoot, "origin.git")]);
    git(parent, "remote", "add", "origin", join(outerRoot, "origin.git"));
    git(parent, "fetch", "-q", "origin");
    const head = git(realWt, "rev-parse", "HEAD");

    // The divergence must sit in an ancestor component; canonicalOwnership's
    // lstat symlink veto operates on the raw cwd's final component only, and
    // must NOT itself refuse the positive control before canonicalization is
    // exercised.
    assert.equal((await lstat(linkWt)).isSymbolicLink(), false, "final path component must be a real directory");
    assert.notEqual(linkWt, realWt, "the two spellings must be lexically distinct");
    assert.equal(await realpath(linkWt), realWt, "the symlinked spelling must realpath to the real worktree");
    assert.equal(await realpath(link2Wt), realWt, "the second symlinked spelling must realpath to the same real worktree");

    const now = Date.now();
    // Workspace cwd reaches the classifier via the symlinked spelling; agent
    // cwd reaches it already realpath'd. Same worktree, two spellings.
    const agent = { id: "agent-div-99", cwd: realWt, status: "closed", updatedAt: new Date(now - 48 * 3600e3).toISOString() };
    // Mutable per-phase toggles, so later phases (terminal presence, a
    // second workspace record) don't retroactively change what the earlier
    // positive/negative-control phases observed through the same closure.
    let terminalRecords = [];
    let includeSecondWorkspace = false;
    const runPaseoJson = async (args) => {
      const a = args.join(" ");
      if (a.startsWith("workspace ls")) {
        const list = [{ workspaceId: "wks-div-99", project: "demo", name: "t-div-99", isolation: "worktree", cwd: linkWt }];
        if (includeSecondWorkspace) {
          list.push({ workspaceId: "wks-div-99b", project: "demo", name: "t-div-99b", isolation: "worktree", cwd: link2Wt });
        }
        return list;
      }
      if (a.includes("harness.retention=keep")) return [];
      if (a.includes("harness.retention=ephemeral")) return [agent];
      if (a.startsWith("ls -g -a")) return [agent];
      if (a.startsWith("ls -g")) return [];
      if (a.startsWith("terminal ls")) return terminalRecords;
      if (a.startsWith("inspect")) return { Id: "agent-div-99", Cwd: realWt, Archived: true, PendingPermissions: [] };
      if (a.startsWith("daemon status")) return { daemonVersion: "0.6.1" };
      throw new Error(`unmocked paseo call: ${a}`);
    };
    const run = (overrides = {}) => collectDailyReconciliation({
      project: "demo", paseoHome: home, retireAfterMs: 60_000, includeOrphans: false,
      now, runPaseoJson, baseRef: "origin/main", commandTimeoutMs: 10_000,
      ...overrides,
    });

    // Phase 1: positive control.
    const positive = await run();
    assert.equal(positive.summary.candidates, 1,
      `divergent spellings must still correlate to candidate; refused: ${JSON.stringify(positive.workspaces.refused.map((w) => w.blockers))}`);
    const candidate = positive.workspaces.candidates[0];
    assert.equal(candidate.proposedAction.type, "review_workspace_archive");
    assert.equal(candidate.proposedAction.expectedHead, head);
    assert.equal(candidate.proposedAction.expectedCwd, linkWt, "report-facing cwd stays the literal spelling, never the canonical form");
    assert.equal(candidate.cwd, linkWt, "the workspace's own report-facing cwd also stays literal");

    // Phase 2: negative control via the real lsof probe.
    const occupant = spawn("sleep", ["30"], { cwd: linkWt, stdio: "ignore" });
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      const negative = await run();
      assert.equal(negative.summary.candidates, 0);
      const kept = negative.workspaces.refused[0];
      assert.equal(kept.state, "keep", "an occupied worktree reached via the symlinked spelling must still be a confirmed keep, not cannot_verify");
      const processBlocker = kept.blockers.find((item) => item.code === "process_cwd_active");
      assert.ok(processBlocker, "process_cwd_active must be present");
      assert.equal(processBlocker.certainty, "confirmed");
      assert.ok(processBlocker.details.includes(occupant.pid), "the occupant pid must be in the evidence");
    } finally {
      occupant.kill("SIGKILL");
    }
    // Let the OS release the occupant's cwd handle before the real lsof
    // probe runs again in the next phase, or it may still read in-use.
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));

    // Phase 3 (mutation site 3 — terminalsUnder cwd containment): a terminal
    // record with NO matching workspaceId (forcing the containment branch,
    // not the id-equality branch) but a cwd already in the REALPATH'd form —
    // divergent from the workspace's symlinked raw cwd. A regression to
    // `isPathInside(workspace.cwd, terminal.cwd)` (raw vs raw: linkWt vs
    // realWt) is lexically unrelated and would silently drop this terminal,
    // losing the terminal_active blocker and reopening a false candidate.
    terminalRecords = [{ terminalId: "term-div-99", workspaceId: null, cwd: realWt }];
    const withTerminal = await run();
    assert.equal(withTerminal.summary.candidates, 0,
      "a terminal reachable only via canonical cwd containment must still veto candidacy");
    const terminalKept = withTerminal.workspaces.refused[0];
    assert.equal(terminalKept.state, "keep");
    const terminalBlocker = terminalKept.blockers.find((item) => item.code === "terminal_active");
    assert.ok(terminalBlocker, "terminal_active must fire from canonical cwd containment alone (no workspaceId match)");
    assert.deepEqual(terminalBlocker.details, ["term-div-99"]);
    terminalRecords = [];

    // Phase 4 (mutation site 5 — orphan/active dedup, FAIL-OPEN severity): the
    // on-disk worktree directory backing the active workspace must never also
    // surface as its own orphan-removal candidate. A regression from
    // canonical dedup back to comparing the raw workspace cwd (linkWt)
    // against the always-canonical orphan-scan path (realWt, since
    // worktreeRoot is realpath'd once per run) would fail to match — the
    // active worktree's own directory would then pass the orphan lane's full
    // evidence chain and appear as a `review_orphan_worktree_removal`
    // candidate for a directory that is simultaneously in active use.
    const withOrphans = await run({ includeOrphans: true });
    assert.equal(withOrphans.sources.orphanScan.ok, true);
    assert.equal(withOrphans.sources.orphanScan.totalDiscovered, 0,
      "the active worktree's own directory must be excluded before orphan classification, not merely refused after it");
    assert.equal(withOrphans.orphanWorktrees.candidates.length, 0,
      "the worktree reached via the symlinked spelling must never appear as its own orphan-removal candidate");
    assert.equal(withOrphans.orphanWorktrees.refused.length, 0);

    // Phase 5 (site 6, residual-risk tier — sharedWorkspaceIds): a second
    // workspace record at a THIRD spelling of the same real directory
    // (link2Wt) must be detected as sharing cwd with the first via canonical
    // comparison, vetoing both with multiple_workspace_references.
    includeSecondWorkspace = true;
    const shared = await run();
    assert.equal(shared.summary.candidates, 0, "two workspace records sharing a canonical cwd must both be vetoed");
    assert.equal(shared.workspaces.refused.length, 2);
    for (const entry of shared.workspaces.refused) {
      assert.equal(entry.state, "keep");
      const sharedBlocker = entry.blockers.find((item) => item.code === "multiple_workspace_references");
      assert.ok(sharedBlocker, `multiple_workspace_references must fire for ${entry.workspaceId}`);
      assert.deepEqual(sharedBlocker.details, ["wks-div-99", "wks-div-99b"]);
    }
    includeSecondWorkspace = false;
  } finally {
    await rm(outerRoot, { recursive: true, force: true });
  }
});
