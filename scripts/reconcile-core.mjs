import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const RECONCILE_SCHEMA = "paseo.team-reconcile/v1";
export const DEFAULT_RETIRE_AFTER_MS = 24 * 60 * 60_000;

/** Lexical containment check. Callers must realpath both values first. */
export function isPathInside(root, candidate) {
  const from = resolve(root);
  const to = resolve(candidate);
  const rel = relative(from, to);
  // A path on a different Windows drive yields an ABSOLUTE `rel` (e.g. "D:\x")
  // that starts with neither ".." nor sep — it must never read as contained.
  if (isAbsolute(rel)) return false;
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function blocker(code, certainty = "confirmed", details = undefined) {
  return { code, certainty, ...(details === undefined ? {} : { details }) };
}

function ageBlocker(ageMs, retireAfterMs) {
  if (!Number.isFinite(ageMs) || !Number.isFinite(retireAfterMs)) return blocker("age_unknown", "unknown");
  if (ageMs < retireAfterMs) {
    return blocker("grace_period_active", "confirmed", { ageMs, retireAfterMs });
  }
  return null;
}

/**
 * Every inventory this module reads is either a real array or evidence that
 * something upstream is malformed. A malformed inventory must never read as
 * "empty" — that direction fails open.
 */
function inventoryBlockers(name, value) {
  if (value === undefined || Array.isArray(value)) return { list: value ?? [], blockers: [] };
  return { list: [], blockers: [blocker(`${name}_inventory_malformed`, "unknown", typeof value)] };
}

export function classifyAgentHealth(agent) {
  // A malformed agent record must fail closed, never crash the whole pass.
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return {
      agentId: "",
      state: "cannot_verify",
      blockers: [blocker("agent_record_malformed", "unknown", typeof agent)],
    };
  }
  const blockers = [];
  if (agent.inspectOk !== true) blockers.push(blocker("agent_inspect_failed", "unknown"));
  const pending = inventoryBlockers("pending_permissions", agent.pendingPermissions);
  blockers.push(...pending.blockers);
  if (pending.list.length > 0) {
    blockers.push(blocker("permission_pending"));
  }
  if (agent.archived !== true) blockers.push(blocker("agent_not_archived"));
  if (agent.retention === "keep") blockers.push(blocker("retention_keep"));
  else if (agent.retention !== "ephemeral") blockers.push(blocker("retention_unknown", "unknown"));
  return {
    agentId: agent.id,
    state: blockers.some((item) => item.certainty === "unknown")
      ? "cannot_verify"
      : blockers.length > 0
        ? "keep"
        : "closed",
    blockers,
  };
}

function gitBlockers(git) {
  if (!git || git.ok !== true) return [blocker("git_unknown", "unknown", git?.error)];
  const blockers = [];
  // A standalone clone (git-dir === git-common-dir) may hold branches with
  // unpushed work that HEAD-only evidence cannot see; it is never a candidate.
  if (git.linkedWorktree === false) blockers.push(blocker("not_linked_worktree"));
  else if (git.linkedWorktree !== true) blockers.push(blocker("worktree_link_unknown", "unknown"));
  if (git.clean !== true) blockers.push(blocker("worktree_dirty"));
  if (!Array.isArray(git.ignoredFiles)) blockers.push(blocker("ignored_files_unknown", "unknown"));
  else if (git.ignoredFiles.length > 0) blockers.push(blocker("ignored_files_present", "confirmed", git.ignoredFiles));
  if (!git.head) blockers.push(blocker("head_unknown", "unknown"));
  if (!git.branch) blockers.push(blocker("detached_or_branch_unknown", "unknown"));
  if (!git.baseRef) blockers.push(blocker("base_ref_unknown", "unknown"));
  if (git.baseTargetsCurrentBranch === true) blockers.push(blocker("base_ref_is_current_branch"));
  if (git.mergedIntoBase !== true) blockers.push(blocker("head_not_merged_into_base"));
  if (!Array.isArray(git.remoteRefs) || git.remoteRefs.length === 0) {
    blockers.push(blocker("head_not_reachable_from_remote"));
  }
  return blockers;
}

function runtimeBlockers(input) {
  const blockers = [];
  if (input.paseoVersionStatus === "unsupported") {
    blockers.push(blocker("paseo_version_unsupported", "unknown", input.paseoVersion));
  } else if (input.paseoVersionStatus !== "supported") {
    blockers.push(blocker("paseo_version_unknown", "unknown"));
  }
  const foreign = inventoryBlockers("foreign_active_agents", input.foreignActiveAgents);
  const active = inventoryBlockers("active_agents", input.activeAgents);
  const terminals = inventoryBlockers("terminals", input.terminals);
  const shared = inventoryBlockers("shared_workspace_ids", input.sharedWorkspaceIds);
  blockers.push(...foreign.blockers, ...active.blockers, ...terminals.blockers, ...shared.blockers);
  if (foreign.list.length > 0) {
    blockers.push(blocker("foreign_agent_active", "confirmed", foreign.list));
  }
  if (shared.list.length > 1) {
    blockers.push(blocker("multiple_workspace_references", "confirmed", shared.list));
  }
  if (active.list.length > 0) {
    blockers.push(blocker("agent_active", "confirmed", active.list));
  }
  if (terminals.list.length > 0) {
    blockers.push(blocker("terminal_active", "confirmed", terminals.list));
  }
  if (input.processUse?.state === "in-use") {
    blockers.push(blocker("process_cwd_active", "confirmed", input.processUse.pids ?? []));
  } else if (input.processUse?.state !== "clear") {
    blockers.push(blocker("process_use_unknown", "unknown", input.processUse?.error));
  }
  return blockers;
}

function resultState(blockers) {
  if (blockers.length === 0) return "candidate";
  return blockers.some((item) => item.certainty === "unknown") ? "cannot_verify" : "keep";
}

/**
 * Classify an active Paseo workspace. This function only proposes a review;
 * it never turns evidence into an archive/delete command.
 */
export function classifyWorkspaceRetirement(input, options = {}) {
  const retireAfterMs = Math.max(60_000, options.retireAfterMs ?? DEFAULT_RETIRE_AFTER_MS);
  const managed = inventoryBlockers("managed_agents", input.managedAgents);
  const agentHealth = managed.list.map(classifyAgentHealth);
  const blockers = [...managed.blockers];
  if (input.isolation !== "worktree") blockers.push(blocker("not_worktree"));
  if (input.paseoOwned !== true) blockers.push(blocker("paseo_ownership_unknown", "unknown"));
  if (managed.list.length === 0) blockers.push(blocker("no_managed_agent_history", "unknown"));
  for (const health of agentHealth) blockers.push(...health.blockers);
  blockers.push(...runtimeBlockers(input));
  blockers.push(...gitBlockers(input.git));
  const age = ageBlocker(input.ageMs, retireAfterMs);
  if (age) blockers.push(age);

  const state = resultState(blockers);
  return {
    kind: "active-workspace",
    workspaceId: input.workspaceId,
    project: input.project,
    name: input.name,
    cwd: input.cwd,
    isolation: input.isolation,
    state,
    ageMs: Number.isFinite(input.ageMs) ? input.ageMs : null,
    managedAgentIds: managed.list.map((agent) => String(agent?.id ?? "")).sort(),
    blockers,
    evidence: {
      git: input.git,
      processUse: input.processUse,
      terminals: input.terminals,
      sharedWorkspaceIds: input.sharedWorkspaceIds ?? [input.workspaceId],
    },
    proposedAction: state === "candidate" ? {
      type: "review_workspace_archive",
      workspaceId: input.workspaceId,
      expectedCwd: input.cwd,
      expectedHead: input.git.head,
      expectedBranch: input.git.branch,
      expectedBaseRef: input.git.baseRef,
      requiresHumanConfirmation: true,
    } : null,
  };
}

/** Paseo-owned worktree path which is absent from the active workspace list. */
export function classifyOrphanWorktree(input, options = {}) {
  const retireAfterMs = Math.max(60_000, options.retireAfterMs ?? DEFAULT_RETIRE_AFTER_MS);
  const blockers = [];
  if (input.paseoVersionStatus === "unsupported") {
    blockers.push(blocker("paseo_version_unsupported", "unknown", input.paseoVersion));
  } else if (input.paseoVersionStatus !== "supported") {
    blockers.push(blocker("paseo_version_unknown", "unknown"));
  }
  if (input.paseoOwned !== true) blockers.push(blocker("paseo_ownership_unknown", "unknown"));
  const managed = inventoryBlockers("managed_agents", input.managedAgents);
  blockers.push(...managed.blockers);
  if (managed.list.length === 0) {
    blockers.push(blocker("no_managed_agent_history", "unknown"));
  } else {
    for (const agent of managed.list) {
      blockers.push(...classifyAgentHealth(agent).blockers);
    }
  }
  const active = inventoryBlockers("active_agents", input.activeAgents);
  const terminals = inventoryBlockers("terminals", input.terminals);
  blockers.push(...active.blockers, ...terminals.blockers);
  if (active.list.length > 0) {
    blockers.push(blocker("agent_active", "confirmed", active.list));
  }
  if (terminals.list.length > 0) {
    blockers.push(blocker("terminal_active", "confirmed", terminals.list));
  }
  if (input.processUse?.state === "in-use") {
    blockers.push(blocker("process_cwd_active", "confirmed", input.processUse.pids ?? []));
  } else if (input.processUse?.state !== "clear") {
    blockers.push(blocker("process_use_unknown", "unknown", input.processUse?.error));
  }
  blockers.push(...gitBlockers(input.git));
  const age = ageBlocker(input.ageMs, retireAfterMs);
  if (age) blockers.push(age);
  const state = resultState(blockers);
  return {
    kind: "orphan-worktree",
    cwd: input.cwd,
    state,
    ageMs: Number.isFinite(input.ageMs) ? input.ageMs : null,
    managedAgentIds: (Array.isArray(input.managedAgents) ? input.managedAgents : []).map((agent) => String(agent?.id ?? "")).sort(),
    blockers,
    evidence: { git: input.git, processUse: input.processUse },
    proposedAction: state === "candidate" ? {
      type: "review_orphan_worktree_removal",
      expectedCwd: input.cwd,
      expectedHead: input.git.head,
      expectedBranch: input.git.branch,
      expectedBaseRef: input.git.baseRef,
      requiresHumanConfirmation: true,
    } : null,
  };
}

export function buildReconciliationReport(input) {
  const workspaces = [...input.workspaces].sort((a, b) =>
    String(a.workspaceId ?? a.cwd).localeCompare(String(b.workspaceId ?? b.cwd)));
  const orphans = [...input.orphans].sort((a, b) => a.cwd.localeCompare(b.cwd));
  const all = [...workspaces, ...orphans];
  const branchByName = new Map();
  for (const item of all) {
    if (item.state !== "candidate" || !item.evidence?.git?.branch) continue;
    // Dedupe by branch name: two worktrees on one branch must not emit two
    // retirement actions, and a stable key keeps planDigest deterministic.
    if (branchByName.has(item.evidence.git.branch)) continue;
    branchByName.set(item.evidence.git.branch, {
      type: "review_local_branch_retirement",
      branch: item.evidence.git.branch,
      expectedHead: item.evidence.git.head,
      expectedBaseRef: item.evidence.git.baseRef,
      workspaceId: item.workspaceId ?? null,
      cwd: item.cwd,
      onlyAfterWorktreeRetired: true,
      remoteDeletion: false,
      requiresHumanConfirmation: true,
    });
  }
  const branchCandidates = [...branchByName.values()]
    .sort((a, b) => a.branch.localeCompare(b.branch) || a.cwd.localeCompare(b.cwd));
  const proposedActions = [
    ...all.map((item) => item.proposedAction).filter(Boolean),
    ...branchCandidates,
  ];
  const planDigest = `sha256:${createHash("sha256").update(JSON.stringify(proposedActions)).digest("hex")}`;
  const generatedAtMs = Date.parse(input.generatedAt);
  return {
    schema: RECONCILE_SCHEMA,
    generatedAt: input.generatedAt,
    mutates: false,
    policy: {
      completion: "archived agents plus positive workspace/Git evidence; idle, age, name, and done labels are not completion evidence",
      completedArtifacts: "remove cleaner-owned active entries; never preserve a done marker",
      cleanup: "review-only: no stop, archive, worktree removal, branch deletion, or file deletion",
    },
    scope: input.scope,
    sources: input.sources,
    summary: {
      candidates: all.filter((item) => item.state === "candidate").length,
      keep: all.filter((item) => item.state === "keep").length,
      cannotVerify: all.filter((item) => item.state === "cannot_verify").length,
    },
    cleanupPlan: {
      digest: planDigest,
      expiresAt: Number.isFinite(generatedAtMs)
        ? new Date(generatedAtMs + 24 * 60 * 60_000).toISOString()
        : null,
      applySupported: false,
    },
    agents: input.agents,
    workspaces: {
      candidates: workspaces.filter((item) => item.state === "candidate"),
      refused: workspaces.filter((item) => item.state !== "candidate"),
    },
    orphanWorktrees: {
      candidates: orphans.filter((item) => item.state === "candidate"),
      refused: orphans.filter((item) => item.state !== "candidate"),
    },
    branches: { candidates: branchCandidates },
    proposedActions,
  };
}
