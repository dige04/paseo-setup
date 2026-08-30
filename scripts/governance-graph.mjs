#!/usr/bin/env node
/**
 * governance-graph.mjs — render the live Paseo team topology as a graph.
 *
 * Answers the question the flat agent list cannot: who governs whom, who owns
 * a writable scope right now, and which bounds apply. It emits React Flow
 * nodes/edges consumed by web/governance-graph.html.
 *
 * Observation-only, exactly like watchdog.mjs: it lists and inspects, and
 * never cancels, archives, spawns or edits anything.
 *
 * Two field-shape facts drive the code (verified against Paseo 0.4.0):
 *   - `paseo ls --json` returns the SAME global list as `ls -g --json`; there
 *     is no server-side workspace scope, so scoping is done here on Cwd.
 *   - `ls` keys are lowercase, `inspect` keys are PascalCase, and only
 *     `inspect` carries ParentAgentId — which is why edges cost one inspect
 *     per agent, bounded below like the watchdog bounds its own fan-out.
 *
 * Role comes from the provider name alone. `inspect` exposes no Labels field,
 * so there is no second source; anything unrecognized renders as `unknown`
 * with no delegation edge. In a governance view a confident wrong edge is
 * worse than a blank one.
 *
 *   node scripts/governance-graph.mjs                 # scope: cwd, to stdout
 *   node scripts/governance-graph.mjs --all --out g.json
 *   node scripts/governance-graph.mjs --serve 7788    # viewer + live JSON
 *   node scripts/governance-graph.mjs --assert        # invariants A1–A6, exit 3 on violation
 */

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint, resolvePaseoExec } from "./lib-common.mjs";
import { retryWithBackoff } from "./reliability.mjs";
import { runPaseoJson } from "./watchdog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const GOVERNANCE_GRAPH_ERROR_CODES = Object.freeze(["USAGE", "COLLECTION_FAILED", "GRAPH_FAILED"]);

export class GovernanceGraphError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "GovernanceGraphError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new GovernanceGraphError(code, message);
}

let cachedExec = null;
/** [command, ...leadingArgs] — the same contract watchdog.mjs relies on. */
function paseoExec() {
  cachedExec ??= resolvePaseoExec();
  return cachedExec;
}

export const DEFAULT_GLOBAL_DEADLINE_MS = 30_000;
export const DEFAULT_INSPECT_CONCURRENCY = 6;
export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

const ROLE_SUFFIXES = [
  ["supervisor", "supervisor"],
  ["lead", "lead"],
  ["peer", "peer"],
];

/**
 * Derive the governance role from the Paseo provider name, e.g. `claude-lead`
 * or `pi-peer`. A bare provider (`claude`, `codex`) has no declared role and
 * must stay `unknown` — guessing would invent authority that nothing granted.
 */
export function roleFromProvider(provider) {
  const name = String(provider ?? "").toLowerCase().split("/")[0] ?? "";
  for (const [suffix, role] of ROLE_SUFFIXES) {
    if (name === suffix || name.endsWith(`-${suffix}`)) return role;
  }
  return "unknown";
}

/** Normalize one agent across the two casings Paseo uses. */
export function normalizeAgent(listed, detail) {
  const d = detail ?? {};
  const provider = d.Provider ?? String(listed.provider ?? "").split("/")[0] ?? "";
  const model = d.Model ?? String(listed.provider ?? "").split("/").slice(1).join("/");
  return {
    id: listed.id ?? d.Id,
    shortId: listed.shortId ?? String(listed.id ?? d.Id ?? "").slice(0, 7),
    name: d.Name ?? listed.name ?? "",
    provider,
    model,
    role: roleFromProvider(provider),
    status: String(d.Status ?? listed.status ?? "unknown").toLowerCase(),
    mode: d.Mode ?? null,
    cwd: d.Cwd ?? listed.cwd ?? "",
    worktree: d.Worktree ?? null,
    parentAgentId: d.ParentAgentId ?? null,
    pendingPermissions: d.PendingPermissions ?? [],
    updatedAt: d.UpdatedAt ?? null,
    inspectOk: Boolean(detail),
  };
}

/** Same "suspected, never asserted" rule the watchdog uses. */
export function markStale(agent, { now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  if (agent.status !== "running" || !agent.inspectOk) return { ...agent, stale: false };
  const updated = Date.parse(agent.updatedAt ?? "");
  const ageMs = Number.isFinite(updated) ? Math.max(0, now - updated) : null;
  return { ...agent, ageMs, stale: ageMs !== null && ageMs >= staleAfterMs };
}

/** Expand `~` so a --cwd filter can be compared against Paseo's own output. */
function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? join(process.env.HOME ?? "", p.slice(1)) : p;
}

export function inScope(agent, { all, cwd }) {
  if (all) return true;
  if (!cwd) return true;
  return resolve(expandHome(agent.cwd || "")) === resolve(expandHome(cwd));
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

const COLUMN_X = { control: 0, lead: 420, peer: 900, workspace: 1380 };
const ROW_H = 170;

function policySummary() {
  return {
    supervisor: "observe · no write · no orchestration",
    lead: "orchestrate · delegate · accept",
    peer: "one bounded scope · authority from the current V3 brief only",
    leadWrite: process.env.PASEO_TEAM_LEAD_WRITE ? "enabled" : "disabled",
  };
}

/**
 * Build the React Flow graph. Declared nodes (control plane, run policy,
 * workspaces) come from configuration; live nodes come from Paseo. Both belong
 * in a governance view: the bounds are as much a fact as the agents.
 */
export function buildGraph(agents, { daemon = {}, generatedAt, scope } = {}) {
  const nodes = [];
  const edges = [];
  const byId = new Map(agents.map((a) => [a.id, a]));

  nodes.push({
    id: "control-plane",
    type: "governance",
    position: { x: COLUMN_X.control, y: 0 },
    data: {
      kind: "CONTROL PLANE",
      title: "Paseo daemon",
      detail: [daemon.status ?? "unknown", daemon.version ? `v${daemon.version}` : null, daemon.hostname]
        .filter(Boolean)
        .join(" · "),
      tone: daemon.status === "running" ? "ok" : "warn",
    },
  });
  nodes.push({
    id: "run-policy",
    type: "governance",
    position: { x: COLUMN_X.control, y: ROW_H * 1.4 },
    data: {
      kind: "RUN POLICY",
      title: "paseo-team role pack",
      detail: `lead write: ${policySummary().leadWrite} · V3 brief is the only grant`,
      tone: "ok",
      policy: policySummary(),
    },
  });

  const leads = agents.filter((a) => a.role === "lead");
  const peers = agents.filter((a) => a.role === "peer");
  const supervisors = agents.filter((a) => a.role === "supervisor");
  const unknown = agents.filter((a) => a.role === "unknown");

  // A Lead's load is the number it actually owns, counted from real parentage.
  const childrenOf = (id) => agents.filter((a) => a.parentAgentId === id);
  const leadDetail = (agent) => {
    const kids = childrenOf(agent.id);
    const active = kids.filter((k) => k.status === "running").length;
    return `${agent.status} · ${kids.length} peer${kids.length === 1 ? "" : "s"} · ${active} active`;
  };

  const place = (list, x, startY) =>
    list.forEach((agent, i) => {
      nodes.push({
        id: agent.id,
        type: "agent",
        position: { x, y: startY + i * ROW_H },
        data: {
          kind: agent.role.toUpperCase(),
          title: agent.shortId,
          name: agent.name,
          detail:
            agent.role === "lead"
              ? leadDetail(agent)
              : `${agent.status}${agent.stale ? " · stale?" : ""} · ${agent.provider}${agent.model ? `/${agent.model}` : ""}`,
          role: agent.role,
          status: agent.status,
          mode: agent.mode,
          stale: Boolean(agent.stale),
          pending: (agent.pendingPermissions ?? []).length,
          cwd: agent.cwd,
        },
      });
    });

  place(supervisors, COLUMN_X.control, ROW_H * 3);
  place(leads, COLUMN_X.lead, 0);
  place(peers, COLUMN_X.peer, 0);
  place(unknown, COLUMN_X.peer, ROW_H * (peers.length + 1));

  // governs — the governance plane observes every Lead.
  for (const s of supervisors) {
    for (const l of leads) {
      edges.push({ id: `gov-${s.id}-${l.id}`, source: s.id, target: l.id, label: "governs", data: { kind: "governs" } });
    }
  }
  // bounds — the policy binds every agent that declares a role.
  for (const a of [...supervisors, ...leads, ...peers]) {
    edges.push({ id: `bnd-${a.id}`, source: "run-policy", target: a.id, label: "bounds", data: { kind: "bounds" } });
  }
  // governs — the daemon owns lifecycle truth for the whole set.
  for (const a of [...supervisors, ...leads]) {
    edges.push({ id: `cp-${a.id}`, source: "control-plane", target: a.id, label: "governs", data: { kind: "governs" } });
  }
  // delegates — real parentage only, and only when inspect confirmed it.
  for (const p of [...peers, ...unknown]) {
    if (!p.parentAgentId || !byId.has(p.parentAgentId)) continue;
    edges.push({
      id: `del-${p.parentAgentId}-${p.id}`,
      source: p.parentAgentId,
      target: p.id,
      label: "delegates",
      data: { kind: "delegates" },
    });
  }

  // checkpoints — one workspace node per distinct cwd the peers actually touch.
  const workspaces = [...new Set(agents.map((a) => a.cwd).filter(Boolean))];
  workspaces.forEach((cwd, i) => {
    const id = `workspace:${cwd}`;
    nodes.push({
      id,
      type: "governance",
      position: { x: COLUMN_X.workspace, y: i * ROW_H * 1.6 },
      data: {
        kind: "DURABLE TRUTH",
        title: cwd.split("/").pop() || cwd,
        detail: cwd,
        tone: "muted",
      },
    });
    for (const a of agents.filter((x) => x.cwd === cwd && x.role !== "unknown")) {
      edges.push({
        id: `chk-${a.id}`,
        source: a.id,
        target: id,
        label: "checkpoints",
        data: { kind: "checkpoints" },
      });
    }
  });

  return {
    meta: {
      generatedAt: generatedAt ?? new Date().toISOString(),
      scope,
      daemon,
      openable: agents.filter((a) => a.role !== "unknown").map((a) => a.id),
      counts: {
        tasks: agents.length,
        leads: leads.length,
        peers: peers.length,
        supervisors: supervisors.length,
        unknown: unknown.length,
        active: agents.filter((a) => a.status === "running").length,
      },
      note: "observation-only: this view never cancels, archives or spawns",
    },
    nodes,
    edges,
  };
}

// ---------------------------------------------------------------------------
// Topology invariants (--assert)
// ---------------------------------------------------------------------------

export const ASSERT_RULES = Object.freeze({
  A1: "one-writer-per-scope",
  A2: "writer-is-acceptor",
  A3: "unknown-role-in-governed-scope",
  A4: "peer-orchestrates",
  A5: "supervisor-not-observe-only",
  A6: "count-integrity",
});

/**
 * Classify write posture from the Mode `inspect` reports. Only unambiguous
 * modes are classified; everything else — a missing mode (inspect failed or
 * withheld the field) and approval-gated modes like "default" — is "unknown",
 * because an approval-gated agent may or may not be writing and guessing in
 * either direction would invent a signal the graph does not carry.
 */
export function writePosture(mode) {
  if (mode === null || mode === undefined || mode === "") return "unknown";
  const normalized = String(mode).toLowerCase().replace(/[\s_-]/g, "");
  if (["plan", "readonly", "observe"].includes(normalized)) return "read-only";
  if (["acceptedits", "bypasspermissions", "yolo", "write", "edit"].includes(normalized)) return "write";
  return "unknown";
}

/**
 * Evaluate topology invariants A1–A6 over an already-built graph. Pure: no
 * daemon, no I/O, deterministic output for a given graph.
 *
 * Returns { violations, cannotVerify }, each entry { id, rule, agents,
 * evidence }. Fail-closed honesty: an invariant whose signal is not derivable
 * from the graph lands in cannotVerify with a concrete reason — unknown is
 * never pass, and inventing a signal is worse than admitting blindness.
 */
export function assertTopology(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const meta = graph?.meta ?? {};
  const violations = [];
  const cannotVerify = [];
  const entry = (rule, key, agentIds, evidence) => ({
    id: `${rule}:${key}`,
    rule: `${rule}-${ASSERT_RULES[rule]}`,
    agents: [...agentIds].sort(),
    evidence,
  });

  const agents = nodes
    .filter((n) => n?.type === "agent")
    .map((n) => ({
      id: n.id,
      role: n.data?.role ?? "unknown",
      status: n.data?.status ?? "unknown",
      mode: n.data?.mode ?? null,
      cwd: n.data?.cwd ?? "",
      posture: writePosture(n.data?.mode),
    }));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const modeLabel = (a) => (a.mode === null ? "mode absent (no inspect data)" : `unrecognized mode "${a.mode}"`);

  // A1 — more than one write-capable peer sharing one scope.
  const peers = agents.filter((a) => a.role === "peer");
  const noScope = peers.filter((a) => !a.cwd);
  if (noScope.length > 0) {
    cannotVerify.push(entry("A1", "(no-scope)", noScope.map((a) => a.id),
      `${noScope.length} peer agent(s) carry no cwd signal; scope sharing cannot be evaluated for them`));
  }
  const peersByCwd = new Map();
  for (const p of peers.filter((a) => a.cwd)) {
    if (!peersByCwd.has(p.cwd)) peersByCwd.set(p.cwd, []);
    peersByCwd.get(p.cwd).push(p);
  }
  for (const cwd of [...peersByCwd.keys()].sort()) {
    const group = peersByCwd.get(cwd);
    const writers = group.filter((a) => a.posture === "write");
    const unknowns = group.filter((a) => a.posture === "unknown");
    if (writers.length > 1) {
      violations.push(entry("A1", cwd, writers.map((a) => a.id),
        `${writers.length} write-capable peers share scope ${cwd}: ${writers.map((a) => `${a.id}(${a.mode})`).sort().join(", ")}`));
    } else if (unknowns.length > 0 && writers.length + unknowns.length > 1) {
      cannotVerify.push(entry("A1", cwd, unknowns.map((a) => a.id),
        `scope ${cwd} has ${writers.length} confirmed writer(s) plus ${unknowns.length} peer(s) whose posture is not derivable (${unknowns.map(modeLabel).sort().join("; ")}); a second writer cannot be ruled out`));
    }
  }

  // A2 — a lead in a write-capable posture; the pack's lead default is read-only.
  const leadWrite = nodes.find((n) => n?.id === "run-policy")?.data?.policy?.leadWrite ?? "undeclared";
  for (const lead of agents.filter((a) => a.role === "lead")) {
    if (lead.posture === "write") {
      violations.push(entry("A2", lead.id, [lead.id],
        `lead ${lead.id} holds write-capable mode "${lead.mode}"; the lead seat accepts, it does not write (leadWrite policy: ${leadWrite})`));
    } else if (lead.posture === "unknown") {
      cannotVerify.push(entry("A2", lead.id, [lead.id],
        `lead ${lead.id} posture is not derivable: ${modeLabel(lead)}; read-only cannot be confirmed`));
    }
  }

  // A3 — an agent with no role suffix inside a scope where role-providers run.
  const governedCwds = new Map();
  for (const a of agents) {
    if (a.role === "unknown" || !a.cwd) continue;
    if (!governedCwds.has(a.cwd)) governedCwds.set(a.cwd, []);
    governedCwds.get(a.cwd).push(a.id);
  }
  for (const u of agents.filter((a) => a.role === "unknown")) {
    if (!u.cwd) {
      cannotVerify.push(entry("A3", u.id, [u.id],
        `agent ${u.id} declares no role and carries no cwd signal; whether it sits inside a governed scope cannot be determined`));
    } else if (governedCwds.has(u.cwd)) {
      violations.push(entry("A3", u.id, [u.id],
        `agent ${u.id} has no role suffix on its provider but is active in governed scope ${u.cwd} alongside role-declared agents [${governedCwds.get(u.cwd).sort().join(", ")}]`));
    }
  }

  // A4 — a peer that parents delegation edges. Edges come only from a real
  // ParentAgentId, so a hit here is a fact, not an inference.
  const delegateTargets = new Map();
  for (const e of edges.filter((x) => x?.data?.kind === "delegates")) {
    if (!delegateTargets.has(e.source)) delegateTargets.set(e.source, []);
    delegateTargets.get(e.source).push(e.target);
  }
  for (const source of [...delegateTargets.keys()].sort()) {
    if (byId.get(source)?.role !== "peer") continue;
    const targets = delegateTargets.get(source).sort();
    violations.push(entry("A4", source, [source, ...targets],
      `peer ${source} parents delegation edge(s) to [${targets.join(", ")}]; a peer holds one bounded scope and never orchestrates`));
  }
  if (meta.partial === true) {
    cannotVerify.push(entry("A4", "(partial)", [],
      "snapshot is partial (capped scan or failed inspects); ParentAgentId is only visible via inspect, so the absence of further delegation edges is not proof that no peer orchestrates"));
  }

  // A5 — a supervisor that orchestrates, or writes where posture is visible.
  for (const sup of agents.filter((a) => a.role === "supervisor")) {
    const targets = (delegateTargets.get(sup.id) ?? []).sort();
    if (targets.length > 0) {
      violations.push(entry("A5", sup.id, [sup.id, ...targets],
        `supervisor ${sup.id} parents delegation edge(s) to [${targets.join(", ")}]; the supervisor seat is observe-only and never orchestrates`));
    }
    if (sup.posture === "write") {
      violations.push(entry("A5", `${sup.id}:posture`, [sup.id],
        `supervisor ${sup.id} holds write-capable mode "${sup.mode}"; the supervisor seat is observe-only`));
    } else if (sup.posture === "unknown") {
      cannotVerify.push(entry("A5", `${sup.id}:posture`, [sup.id],
        `supervisor ${sup.id} posture is not derivable: ${modeLabel(sup)}; observe-only cannot be confirmed`));
    }
  }

  // A6 — counts must never present a capped or partial scan as a total.
  const scan = meta.scan;
  const scanShapeOk =
    scan !== null &&
    typeof scan === "object" &&
    Number.isFinite(scan?.scopedTotal) &&
    Number.isFinite(scan?.rendered) &&
    Number.isFinite(scan?.uninspected) &&
    typeof scan?.truncated === "boolean";
  if (!scanShapeOk) {
    cannotVerify.push(entry("A6", "(no-scan-metadata)", [],
      "meta.scan is absent or malformed, so meta.counts cannot be checked against the pre-cap population; counts must not be read as totals"));
  } else {
    if (scan.rendered < scan.scopedTotal && scan.truncated !== true) {
      violations.push(entry("A6", "truncation-unsignaled", [],
        `scan rendered ${scan.rendered} of ${scan.scopedTotal} in-scope agents but meta.scan.truncated is not true; a capped scan must never read as a total`));
    }
    if ((scan.truncated === true || scan.uninspected > 0) && meta.partial !== true) {
      violations.push(entry("A6", "partial-unsignaled", [],
        `scan reports truncated=${scan.truncated} and uninspected=${scan.uninspected} but meta.partial is not true; incompleteness must be surfaced at the top level`));
    }
    if (Number.isFinite(meta.counts?.tasks) && meta.counts.tasks !== scan.rendered) {
      violations.push(entry("A6", "counts-mismatch", [],
        `meta.counts.tasks=${meta.counts.tasks} does not match meta.scan.rendered=${scan.rendered}; counts must describe exactly the rendered set`));
    }
  }

  const byIdOrder = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  violations.sort(byIdOrder);
  cannotVerify.sort(byIdOrder);
  return { violations, cannotVerify };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export async function collectGraph(options = {}) {
  const deadline = Date.now() + (options.globalDeadlineMs ?? DEFAULT_GLOBAL_DEADLINE_MS);
  const commandTimeoutMs = Math.max(250, options.commandTimeoutMs ?? 5000);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const paseoJson = options.runPaseoJson ?? runPaseoJson;
  const budget = () => Math.max(1, Math.min(commandTimeoutMs, deadline - Date.now()));

  let listed = [];
  let daemon = { status: "unknown" };
  try {
    listed = await retryWithBackoff(() => paseoJson(["ls", "-g"], budget()), {
      maxAttempts,
      baseMs: options.baseMs ?? 100,
      jitter: 0,
      deadlineMs: deadline,
    });
    // One extra call, and it makes the control-plane node say something real.
    // Never fatal: the graph is about the agents, not the version string.
    try {
      const status = await paseoJson(["status"], budget());
      daemon = {
        status: status?.localDaemon ?? "running",
        version: status?.daemonVersion ?? null,
        hostname: status?.hostname ?? null,
      };
    } catch {
      daemon = { status: "running", version: null };
    }
  } catch (error) {
    return {
      ...buildGraph([], { daemon: { status: "unreachable" }, scope: options.scope }),
      error: String(error?.message ?? error),
    };
  }

  const scoped = (Array.isArray(listed) ? listed : []).filter((a) =>
    inScope({ cwd: a.cwd }, { all: options.all, cwd: options.cwd }),
  );
  const capped = scoped.slice(0, Math.max(1, Math.floor(options.maxAgents ?? 100)));

  // Bounded fan-out: ParentAgentId only exists on inspect, so this is the cost.
  const details = new Array(capped.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? DEFAULT_INSPECT_CONCURRENCY));
  async function worker() {
    while (cursor < capped.length && Date.now() < deadline) {
      const i = cursor++;
      try {
        details[i] = await paseoJson(["inspect", capped[i].id], budget());
      } catch {
        details[i] = null; // renders as an un-inspected agent, never as an edge
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, capped.length) }, worker));

  const agents = capped.map((listedAgent, i) =>
    markStale(normalizeAgent(listedAgent, details[i]), { staleAfterMs: options.staleAfterMs }),
  );
  const graph = buildGraph(agents, {
    daemon,
    scope: options.all ? "all" : (options.cwd ?? process.cwd()),
  });
  // A capped scan must never read as a total: meta.counts describes the
  // RENDERED set, so the pre-cap population and the inspect shortfall are
  // published alongside it instead of collapsing into one boolean.
  const uninspected = agents.filter((a) => !a.inspectOk).length;
  graph.meta.scan = {
    listedTotal: Array.isArray(listed) ? listed.length : 0,
    scopedTotal: scoped.length,
    rendered: capped.length,
    truncated: scoped.length > capped.length,
    uninspected,
  };
  graph.meta.partial = graph.meta.scan.truncated || uninspected > 0;
  return graph;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { all: false, cwd: process.cwd(), out: null, serve: null, assert: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--all" || arg === "-g") options.all = true;
    else if (arg === "--assert") options.assert = true;
    else if (arg === "--cwd" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) fail("USAGE", `${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (arg === "--serve") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        const port = Number(argv[++i]);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          fail("USAGE", "--serve port must be an integer between 1 and 65535");
        }
        options.serve = port;
      } else {
        options.serve = 7788;
      }
    } else {
      fail("USAGE", `unknown argument "${arg}"`);
    }
  }
  // --serve is a long-lived viewer; --assert is a one-shot exit-code contract.
  if (options.assert && options.serve) fail("USAGE", "--assert and --serve cannot be combined");
  return options;
}

function viewerHtml() {
  return readFileSync(join(HERE, "..", "web", "governance-graph.html"), "utf8");
}

export const SNAPSHOT_TTL_MS = 5000;

/**
 * Collect at most one snapshot at a time, and reuse a fresh one.
 *
 * The inspect fan-out is the expensive part — measured at ~30s for 85 agents,
 * because each inspect is a CLI spawn. Without this, a polling viewer stacks
 * overlapping collections and the daemon wears the cost of every one.
 */
export function createSnapshotCache(options, { ttlMs = SNAPSHOT_TTL_MS, collect = collectGraph } = {}) {
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;
  return async function snapshot(now = Date.now()) {
    if (cached && now - cachedAt < ttlMs) return cached;
    if (inFlight) return inFlight;
    inFlight = collect(options)
      .then((graph) => {
        cached = graph;
        cachedAt = Date.now();
        return graph;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

async function serve(port, options) {
  const snapshot = createSnapshotCache(options);
  const snapshot_ = snapshot;
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/open")) {
      const agentId = new URL(req.url, "http://127.0.0.1").searchParams.get("agentId") ?? "";
      // Only ids present in the current snapshot may be opened: the endpoint
      // must not become a way to run the CLI with arbitrary input.
      const snapshot = await snapshot_();
      const allowed = new Set(snapshot.meta?.openable ?? []);
      res.writeHead(allowed.has(agentId) ? 200 : 400, { "content-type": "application/json" });
      if (!allowed.has(agentId)) {
        res.end(JSON.stringify({ ok: false, error: "unknown agent id for this graph" }));
        return;
      }
      const [command, ...leading] = paseoExec();
      execFile(command, [...leading, "agent", "open", agentId], { timeout: 10_000 }, (error) => {
        // headers already sent; log rather than throw
        if (error) console.error("open failed:", error.message);
      });
      res.end(JSON.stringify({ ok: true, agentId }));
      return;
    }
    if (req.url?.startsWith("/graph.json")) {
      const graph = await snapshot();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(graph));
      return;
    }
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(viewerHtml());
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`viewer missing: ${String(error?.message ?? error)}`);
    }
  });
  // Loopback only: this exposes agent ids and workspace paths.
  server.listen(port, "127.0.0.1", () => {
    console.log(`governance graph: http://127.0.0.1:${port}  (scope: ${options.all ? "all" : options.cwd})`);
  });
}

function help() {
  return `governance-graph.mjs — render the live Paseo team topology as a graph

Usage:
  node scripts/governance-graph.mjs [--all | --cwd <path>] [--out <file>]
  node scripts/governance-graph.mjs --serve [port]
  node scripts/governance-graph.mjs --assert [--all | --cwd <path>] [--out <file>]

Options:
  --all, -g        every workspace (default: scope to the invoking directory)
  --cwd <path>     scope to one workspace
  --out <file>     write the JSON to a file
  --serve [port]   loopback viewer + live JSON (default port 7788)
  --assert         evaluate topology invariants A1–A6 over the collected graph
                   and print { ok, violations, cannotVerify, meta }
  --help, -h       this text

Assert exit codes:
  0  no violations (cannotVerify may be non-empty — reported, not a failure)
  3  violations found
  2  usage or collection error ({ ok:false, code, message } on stdout)

Invariants: A1 one-writer-per-scope, A2 writer-is-acceptor, A3 unknown-role in
governed scope, A4 peer-orchestrates, A5 supervisor-not-observe-only, A6
count-integrity. Unknown is never pass: a signal the graph does not carry is
reported under cannotVerify with the concrete reason.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(help());
    return;
  }
  if (options.serve) return serve(options.serve, options);
  const graph = await collectGraph(options);
  if (options.assert) {
    // Asserting over an unreachable daemon would pass vacuously on an empty
    // graph. Fail-closed: a collection error is an error, never a green exit.
    if (graph.error) fail("COLLECTION_FAILED", `collection failed: ${graph.error}`);
    const { violations, cannotVerify } = assertTopology(graph);
    const json = JSON.stringify({ ok: violations.length === 0, violations, cannotVerify, meta: graph.meta }, null, 2);
    if (options.out) writeFileSync(options.out, `${json}\n`);
    console.log(json);
    if (violations.length > 0) process.exitCode = 3;
    return;
  }
  const json = JSON.stringify(graph, null, 2);
  if (options.out) {
    writeFileSync(options.out, `${json}\n`);
    console.log(`wrote ${options.out} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
  } else {
    console.log(json);
  }
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  main().catch((error) => {
    const code = error instanceof GovernanceGraphError ? error.code : "GRAPH_FAILED";
    console.log(JSON.stringify({ ok: false, code, message: String(error?.message ?? error) }));
    process.exitCode = 2;
  });
}
