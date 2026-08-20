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
  graph.meta.partial =
    scoped.length > capped.length || agents.some((a) => !a.inspectOk);
  return graph;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { all: false, cwd: process.cwd(), out: null, serve: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all" || arg === "-g") options.all = true;
    else if (arg === "--cwd") options.cwd = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--serve") {
      const next = argv[i + 1];
      options.serve = next && !next.startsWith("-") ? Number(argv[++i]) : 7788;
    }
  }
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.serve) return serve(options.serve, options);
  const graph = await collectGraph(options);
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
    console.error(JSON.stringify({ ok: false, code: "GRAPH_FAILED", message: String(error?.message ?? error) }));
    process.exit(2);
  });
}
