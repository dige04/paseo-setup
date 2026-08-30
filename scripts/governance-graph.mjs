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
 * Three field-shape facts drive the code (re-measured 2026-08-31, Paseo 0.6.x):
 *   - `paseo ls --json` returns the SAME global list as `ls -g --json`; there
 *     is no server-side workspace scope, so scoping is done here on Cwd.
 *   - `ls` keys are lowercase, `inspect` keys are PascalCase, and only
 *     `inspect` carries ParentAgentId — which is why edges cost one inspect
 *     per agent, bounded below like the watchdog bounds its own fan-out.
 *   - the SAME directory arrives spelled `~/x` from `ls` and `/Users/u/x` from
 *     `inspect`. Scope identity is therefore the realpath, resolved once at
 *     ingest (lib-common resolveCanonicalCwds), never the string Paseo handed
 *     us. Raw spellings survive for display only.
 *
 * Role comes from the provider name alone, and that is a KNOWN GAP, not a
 * design: `inspect` exposes no Labels field, so the graph reads roles off the
 * provider suffix that only the pack's own claude-* providers carry. (A second
 * source does exist — `paseo ls --label k=v` filters server-side — but which
 * label carries a role is exactly the taxonomy question F015 owns, and wiring
 * a guess here would make the graph confidently wrong.) Anything unrecognized
 * renders as `unknown` with no delegation edge. In a governance view a
 * confident wrong edge is worse than a blank one.
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
import {
  isEntrypoint,
  leadWriteEnabled,
  normalizePaseoCwd,
  resolveCanonicalCwds,
  resolvePaseoExec,
} from "./lib-common.mjs";
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

/**
 * The provider WITHOUT its role suffix: `claude-peer` and `claude-lead` are
 * both the `claude` harness and publish the same mode vocabulary, while `omp`
 * publishes a different one that happens to reuse the token "write".
 */
export function providerFamily(provider) {
  const name = String(provider ?? "").toLowerCase().split("/")[0] ?? "";
  for (const [suffix] of ROLE_SUFFIXES) {
    if (name.endsWith(`-${suffix}`)) return name.slice(0, -(suffix.length + 1));
    if (name === suffix) return "";
  }
  return name;
}

/**
 * Providers whose writes this pack actually bounds. The PreToolUse hook parses
 * the V3 brief and denies the tool call — it holds even under
 * `bypassPermissions` — and it is armed by `PASEO_CLAUDE_ROLE`, which only
 * these three providers set (config/paseo.providers.claude.example.json).
 */
export const PACK_ENFORCED_PROVIDERS = Object.freeze([
  "claude-supervisor",
  "claude-lead",
  "claude-peer",
]);

/**
 * Provider families documented as bounded by prompt + session mode ONLY — "the
 * hook is passive without PASEO_CLAUDE_ROLE" (skills/paseo-ultra-review/
 * SKILL.md, docs/review-instruments.md). For these seats the Mode really is
 * the only authority signal in existence, so posture means something.
 * `codex` is here on the same general rule: it is not a claude-* provider, so
 * nothing this pack ships can deny its writes.
 */
export const UNENFORCED_PROVIDER_FAMILIES = Object.freeze(["agy", "omp", "codex"]);

/**
 * What, if anything, bounds this seat's writes — the question "what does Mode
 * mean here?" is unanswerable without it.
 *
 * FOR A PACK-ENFORCED SEAT, MODE IS NOT WRITE AUTHORITY, in either direction.
 * The hook decides from a brief the graph cannot read, so `bypassPermissions`
 * on a claude-peer is not evidence of a writer and `plan` is not evidence of a
 * reader. Reading it as authority is what made A1 fire daily on this repo.
 *
 * Everything else — bare `claude`, `pi-*`, `grok`, `cursor`, anything new — is
 * `unknown`: not enforced, not proven unenforced. Unknown never passes and,
 * per the pack-ship ruling, never manufactures a violation either.
 */
export function enforcementClass(provider) {
  const name = String(provider ?? "").toLowerCase().split("/")[0] ?? "";
  if (PACK_ENFORCED_PROVIDERS.includes(name)) return "pack-enforced";
  if (UNENFORCED_PROVIDER_FAMILIES.includes(providerFamily(name))) return "unenforced";
  return "unknown";
}

/**
 * Normalize one agent across the two casings Paseo uses.
 *
 * `canonicalMap` is the ingest-time realpath table (lib-common
 * resolveCanonicalCwds), keyed by the tilde-expanded spelling. A cwd that
 * could not be resolved yields `canonicalCwd: null` PLUS the resolve error:
 * null is "cannot verify", never "somewhere else" and never the raw string
 * quietly promoted back into an identity.
 */
export function normalizeAgent(listed, detail, canonicalMap = null) {
  const d = detail ?? {};
  const provider = d.Provider ?? String(listed.provider ?? "").split("/")[0] ?? "";
  const model = d.Model ?? String(listed.provider ?? "").split("/").slice(1).join("/");
  const cwd = normalizePaseoCwd(d.Cwd ?? listed.cwd ?? "");
  const canonicalEntry = cwd ? canonicalMap?.get(cwd) : undefined;
  const availableModes = Array.isArray(d.AvailableModes) ? d.AvailableModes : [];
  const mode = d.Mode ?? null;
  return {
    id: listed.id ?? d.Id,
    shortId: listed.shortId ?? String(listed.id ?? d.Id ?? "").slice(0, 7),
    name: d.Name ?? listed.name ?? "",
    provider,
    model,
    role: roleFromProvider(provider),
    enforcement: enforcementClass(provider),
    status: String(d.Status ?? listed.status ?? "unknown").toLowerCase(),
    mode,
    // The agent's OWN label for the mode it is in, so an unclassified mode is
    // reported as the daemon names it instead of as a bare token.
    modeLabel: availableModes.find((m) => m?.id === mode)?.label ?? null,
    availableModes,
    cwd,
    canonicalCwd: canonicalEntry?.canonical ?? null,
    cwdError: cwd && !canonicalEntry?.canonical ? (canonicalEntry?.error ?? "cwd was never canonicalized") : null,
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

/**
 * Scope membership on CANONICAL identity when both sides have one.
 *
 * `scopeCanonical` is the realpath of the requested scope, resolved once by
 * the caller. When either side could not be canonicalized the comparison falls
 * back to the lexical spelling — that is a weaker answer, and collectGraph
 * reports every agent it had to decide that way rather than letting an
 * unresolvable path disappear silently.
 */
export function inScope(agent, { all, cwd, scopeCanonical = null }) {
  if (all) return true;
  if (!cwd && !scopeCanonical) return true;
  if (agent.canonicalCwd && scopeCanonical) return agent.canonicalCwd === scopeCanonical;
  // Lexical on BOTH sides or not at all: comparing a raw agent path against a
  // canonical scope would mix the two identity domains in the one branch that
  // exists precisely because a canonical was unavailable.
  return resolve(normalizePaseoCwd(agent.cwd || "")) === resolve(normalizePaseoCwd(cwd || ""));
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
    // COLLECTOR-LOCAL, and labelled as such everywhere it is printed: this is
    // the env of the process drawing the graph, not of any inspected lead. The
    // shared predicate is the fix for a truthy check that read "0" as enabled.
    leadWrite: leadWriteEnabled() ? "enabled" : "disabled",
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
      detail: `lead write (collector-local): ${policySummary().leadWrite} · V3 brief is the only grant`,
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
          provider: agent.provider,
          enforcement: agent.enforcement ?? enforcementClass(agent.provider),
          mode: agent.mode,
          modeLabel: agent.modeLabel ?? null,
          stale: Boolean(agent.stale),
          pending: (agent.pendingPermissions ?? []).length,
          // Raw spelling for the human; canonical identity for every check.
          cwd: agent.cwd,
          canonicalCwd: agent.canonicalCwd ?? null,
          cwdError: agent.cwdError ?? null,
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

  // checkpoints — one workspace node per distinct DIRECTORY. Keyed on the
  // canonical path, so `~/x` and `/Users/u/x` are one node and not two; an
  // unresolvable cwd keeps its raw spelling as a key and says so, because
  // merging it into some other node would be a guess.
  const workspaceKey = (a) => a.canonicalCwd ?? (a.cwd ? `unresolved:${a.cwd}` : "");
  const workspaces = [...new Set(agents.map(workspaceKey).filter(Boolean))];
  workspaces.forEach((key, i) => {
    const members = agents.filter((x) => workspaceKey(x) === key);
    const resolved = members[0]?.canonicalCwd ?? null;
    const cwd = resolved ?? members[0]?.cwd ?? key;
    const id = `workspace:${key}`;
    nodes.push({
      id,
      type: "governance",
      position: { x: COLUMN_X.workspace, y: i * ROW_H * 1.6 },
      data: {
        kind: "DURABLE TRUTH",
        title: cwd.split("/").pop() || cwd,
        detail: resolved ? cwd : `${cwd} (path could not be resolved)`,
        canonical: resolved,
        tone: "muted",
      },
    });
    for (const a of members.filter((x) => x.role !== "unknown")) {
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
 * Mode ids are PROVIDER-NAMESPACED and they collide across providers.
 *
 * Measured 2026-08-31 on the pack's own host, from `paseo inspect <id> --json`
 * → `.AvailableModes` (id = label):
 *   claude  plan="Plan Mode", default="Always Ask", acceptEdits="Accept File
 *           Edits", auto="Auto mode", bypassPermissions="Bypass"
 *   omp     full="Full Access", write="Write Approval", ask="Always Ask"
 *   codex   auto="Default Permissions", auto-review="Auto-review",
 *           full-access="Full Access"
 *
 * omp's `write` is an ASK-FIRST GATE, not a standing grant. The flat token
 * table this replaces matched it as a confirmed writer while missing codex's
 * `full-access` entirely — one table manufacturing violations at one end and
 * losing real ones at the other. Lookup is by exact id: the old fuzzy
 * "lowercase and strip separators" pass is what let `write` collide in the
 * first place.
 *
 * `agy` is classified from documentation, not from the daemon: agy seats
 * publish an EMPTY AvailableModes (measured), and docs/review-instruments.md
 * records the four ACP modes it offers.
 *
 * Live-on-host but deliberately ABSENT: `grok` (Mode "default") and `cursor`
 * (Mode "agent") publish no AvailableModes and no pack documentation says what
 * their modes grant. Absent means unknown means cannot-verify — an entry
 * invented here would be a guess wearing a table's authority.
 */
export const MODE_POSTURES = Object.freeze({
  claude: Object.freeze({
    plan: "read-only",
    default: "approval-gated",
    acceptEdits: "write",
    // "Auto mode": present on every claude seat and undocumented in this pack.
    // Named on purpose so a reader sees it was measured and left unclassified.
    auto: "unknown",
    bypassPermissions: "write",
  }),
  omp: Object.freeze({
    full: "write",
    write: "approval-gated",
    ask: "approval-gated",
  }),
  codex: Object.freeze({
    auto: "approval-gated",
    "auto-review": "approval-gated",
    "full-access": "write",
  }),
  agy: Object.freeze({
    plan: "read-only",
    default: "approval-gated",
    "accept-edits": "write",
    "dangerously-skip-permissions": "write",
  }),
});

/**
 * Write posture of (provider family, mode id) → "write" | "read-only" |
 * "approval-gated" | "unknown".
 *
 * "approval-gated" is a real answer, distinct from "unknown": the mode IS
 * classified and it means a human is asked first. Neither one is a writer and
 * neither one rules a writer out — the difference is only in what the evidence
 * line can honestly say.
 *
 * Posture is never authority on its own. See enforcementClass(): on a
 * pack-enforced seat the hook decides and this value must be ignored.
 */
export function writePosture(provider, mode) {
  if (mode === null || mode === undefined || mode === "") return "unknown";
  const table = MODE_POSTURES[providerFamily(provider)];
  return table?.[String(mode)] ?? "unknown";
}

/**
 * Evaluate topology invariants A1–A6 over an already-built graph. Pure: no
 * daemon, no I/O, no realpath — every path identity it reads was resolved at
 * ingest — and deterministic output for a given graph.
 *
 * Returns { violations, cannotVerify }, each entry { id, rule, agents,
 * evidence } plus `advisory: true` on the entries that are a DEMOTED check
 * rather than a blind one. Three buckets, and the difference matters:
 *   violation    a fact the graph carries that breaks an invariant → exit 3.
 *   cannotVerify a signal the graph does not carry → reported, exit 0.
 *   advisory     a check whose signal exists but is not trustworthy enough to
 *                fail a build on (F015 role vocabulary, idle write-capable
 *                seats) → reported, exit 0, and NAMED so nobody mistakes the
 *                silence for a pass.
 *
 * Fail-closed honesty runs both ways here, which is the pack-ship correction:
 * unknown is never a pass, AND a non-signal is never a violation. An invariant
 * that cries wolf every morning is a broken invariant.
 */
export function assertTopology(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const meta = graph?.meta ?? {};
  const violations = [];
  const cannotVerify = [];
  const entry = (rule, key, agentIds, evidence, options = {}) => ({
    id: `${rule}:${key}`,
    rule: `${rule}-${ASSERT_RULES[rule]}`,
    agents: [...agentIds].sort(),
    evidence,
    ...(options.advisory ? { advisory: true } : {}),
  });

  const agents = nodes
    .filter((n) => n?.type === "agent")
    .map((n) => ({
      id: n.id,
      role: n.data?.role ?? "unknown",
      status: n.data?.status ?? "unknown",
      provider: n.data?.provider ?? "",
      enforcement: n.data?.enforcement ?? enforcementClass(n.data?.provider),
      mode: n.data?.mode ?? null,
      modeLabel: n.data?.modeLabel ?? null,
      cwd: n.data?.cwd ?? "",
      canonicalCwd: n.data?.canonicalCwd ?? null,
      cwdError: n.data?.cwdError ?? null,
      posture: writePosture(n.data?.provider, n.data?.mode),
    }));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const running = (a) => a.status === "running";
  /** How to name a mode we could not turn into authority, in the agent's own words. */
  const modeNote = (a) => {
    if (a.mode === null) return `${a.id}: mode absent (no inspect data)`;
    const named = a.modeLabel ? `"${a.mode}" (${a.provider} calls it "${a.modeLabel}")` : `"${a.mode}"`;
    if (a.posture === "approval-gated") return `${a.id}: approval-gated mode ${named}`;
    return `${a.id}: mode ${named} is not in the ${providerFamily(a.provider) || "(unnamed)"} posture table`;
  };

  // -------------------------------------------------------------------------
  // A1 — one writer per scope. Three signals must line up, and before the
  // pack-ship fix every one of them was being manufactured:
  //
  //   SCOPE      the canonical directory, so `~/x` and `/Users/u/x` are ONE key
  //              instead of two (this split fired on EVERY run — the graph's
  //              own ls/inspect pair spells the same directory both ways).
  //   LIVENESS   status === "running". "May I archive this?" is a question
  //              about an IDLE agent and it belongs to reconcile-observer.mjs,
  //              which has the retention evidence for it. "Is something
  //              mutating this directory right now?" is THIS gate's question,
  //              and a running process is the only evidence of it the graph
  //              carries. An idle seat is not evidence in either direction —
  //              11 idle peers on this repo produced 11 daily false alarms.
  //   AUTHORITY  the mode is write authority only where nothing else bounds the
  //              seat. On a pack-enforced seat the PreToolUse hook decides from
  //              a V3 brief this graph cannot read, so `bypassPermissions`
  //              there is not evidence of a writer.
  //
  // STATED VACUUM (do not "fix" this by loosening a clause): "role === peer AND
  // unenforced" is EMPTY on every fleet the pack can produce today, because
  // role is read off a provider suffix that only the pack-enforced claude-*
  // providers carry. A1's true-positive branch is therefore unreachable in
  // production until F015 gives roles their own source, and its positive
  // control is SYNTHETIC — a hand-built `omp-peer` no shipped config emits.
  // The same vacuum has a second half (U4): omp/agy/codex seats carry no role
  // suffix at all, so A1 never even looks at the fleet that IS unenforced.
  // -------------------------------------------------------------------------
  const peers = agents.filter((a) => a.role === "peer");
  const noScope = peers.filter((a) => !a.cwd);
  if (noScope.length > 0) {
    cannotVerify.push(entry("A1", "(no-scope)", noScope.map((a) => a.id),
      `${noScope.length} peer agent(s) carry no cwd signal; scope sharing cannot be evaluated for them`));
  }
  const unresolvedScope = peers.filter((a) => a.cwd && !a.canonicalCwd);
  if (unresolvedScope.length > 0) {
    cannotVerify.push(entry("A1", "(unresolved-scope)", unresolvedScope.map((a) => a.id),
      `${unresolvedScope.length} peer agent(s) carry a cwd that could not be canonicalized (${unresolvedScope
        .map((a) => `${a.id}: ${a.cwd} — ${a.cwdError ?? "unresolved"}`).sort().join("; ")
      }); an unresolved path is never keyed as a scope of its own and never read as "not in this scope"`));
  }
  const peersByScope = new Map();
  for (const p of peers.filter((a) => a.canonicalCwd)) {
    if (!peersByScope.has(p.canonicalCwd)) peersByScope.set(p.canonicalCwd, []);
    peersByScope.get(p.canonicalCwd).push(p);
  }
  for (const scope of [...peersByScope.keys()].sort()) {
    const group = peersByScope.get(scope);
    const live = group.filter(running);
    const unenforced = live.filter((a) => a.enforcement === "unenforced");
    const writers = unenforced.filter((a) => a.posture === "write");
    const undecidable = unenforced.filter((a) => a.posture !== "write" && a.posture !== "read-only");

    if (writers.length > 1) {
      violations.push(entry("A1", scope, writers.map((a) => a.id),
        `${writers.length} running write-capable peers share scope ${scope}: ${writers.map((a) => `${a.id}(${a.mode})`).sort().join(", ")}; no mechanism in this pack bounds their writes`));
    } else if (undecidable.length > 0 && writers.length + undecidable.length > 1) {
      cannotVerify.push(entry("A1", scope, undecidable.map((a) => a.id),
        `scope ${scope} has ${writers.length} confirmed writer(s) plus ${undecidable.length} running unenforced peer(s) whose posture is not derivable (${undecidable.map(modeNote).sort().join("; ")}); a second writer cannot be ruled out`));
    }

    // One line per scope, not one per seat: the pack-enforced fleet is the
    // common case and its blindness is a property of the SCOPE, not news
    // about each agent in it.
    const enforced = live.filter((a) => a.enforcement === "pack-enforced");
    if (enforced.length > 0) {
      cannotVerify.push(entry("A1", `${scope}:pack-enforced`, enforced.map((a) => a.id),
        `scope ${scope} has ${enforced.length} running pack-enforced seat(s) (${enforced.map((a) => `${a.id}(${a.provider}/${a.mode ?? "no mode"})`).sort().join(", ")}); for these the PreToolUse hook decides write authority from the V3 brief, which this graph cannot read — Mode is not evidence here in either direction`));
    }
    const unclassifiedSeats = live.filter((a) => a.enforcement === "unknown");
    if (unclassifiedSeats.length > 0) {
      cannotVerify.push(entry("A1", `${scope}:unknown-enforcement`, unclassifiedSeats.map((a) => a.id),
        `scope ${scope} has ${unclassifiedSeats.length} running seat(s) on providers this pack neither enforces nor documents as unenforced (${unclassifiedSeats.map((a) => `${a.id}(${a.provider})`).sort().join(", ")}); whether Mode is authority for them is unknown`));
    }

    // Flood control (the 11-idle-peers case): ONE advisory for the scope,
    // pointing at the tool that owns the retire/archive decision.
    const idleWriteCapable = group.filter((a) => !running(a) && a.posture === "write");
    if (idleWriteCapable.length > 0) {
      cannotVerify.push(entry("A1", `${scope}:idle-write-capable`, idleWriteCapable.map((a) => a.id),
        `ADVISORY (not a violation): ${idleWriteCapable.length} non-running peer(s) in scope ${scope} hold a write-capable mode. Idle is not evidence that anything is mutating, and it is not evidence that nothing is; whether these seats should be retired is reconcile-observer.mjs's question, which has the retention signals this graph does not`,
        { advisory: true }));
    }
  }

  // -------------------------------------------------------------------------
  // A2 — DEMOTED TO ADVISORY until F015. The check needs to know that a seat is
  // a lead, and "lead" here means nothing but a provider-name suffix (M3: the
  // enforced role enum {observer,writer,reviewer,lead,supervisor} has zero live
  // instances, while the live fleet carries {peer,scout,architect}). Failing a
  // morning gate on a naming convention is how an exit code stops being read.
  // -------------------------------------------------------------------------
  const leadWrite = nodes.find((n) => n?.id === "run-policy")?.data?.policy?.leadWrite ?? "undeclared";
  for (const lead of agents.filter((a) => a.role === "lead")) {
    if (lead.posture === "write") {
      cannotVerify.push(entry("A2", lead.id, [lead.id],
        `ADVISORY (not a violation): lead ${lead.id} holds write-capable mode "${lead.mode}"; the lead seat accepts, it does not write. ${
          lead.enforcement === "pack-enforced"
            ? "This seat is pack-enforced, so the mode is not its authority — the hook is"
            : "Role here is a provider-name suffix, which F015 records as an unreliable source"
        }. leadWrite is ${leadWrite} in THIS collector's environment, which says nothing about the environment ${lead.id} runs in`,
        { advisory: true }));
    } else if (lead.posture !== "read-only") {
      cannotVerify.push(entry("A2", lead.id, [lead.id],
        `lead ${lead.id} posture is not derivable: ${modeNote(lead)}; read-only cannot be confirmed`));
    }
  }

  // -------------------------------------------------------------------------
  // A3 — DEMOTED TO ADVISORY until F015. "Unknown role" means only "no
  // recognized suffix on the provider name". The documented scout fleet runs on
  // omp/agy/codex providers that carry real, briefed roles the provider name
  // cannot express, so every ultra-review round would trip this rule while
  // behaving exactly as designed. What the check reports is a NAMING gap.
  // -------------------------------------------------------------------------
  const governedScopes = new Map();
  for (const a of agents) {
    if (a.role === "unknown" || !a.canonicalCwd) continue;
    if (!governedScopes.has(a.canonicalCwd)) governedScopes.set(a.canonicalCwd, []);
    governedScopes.get(a.canonicalCwd).push(a.id);
  }
  for (const u of agents.filter((a) => a.role === "unknown")) {
    if (!u.cwd) {
      cannotVerify.push(entry("A3", u.id, [u.id],
        `agent ${u.id} declares no role and carries no cwd signal; whether it sits inside a governed scope cannot be determined`));
    } else if (!u.canonicalCwd) {
      cannotVerify.push(entry("A3", u.id, [u.id],
        `agent ${u.id} declares no role and its cwd ${u.cwd} could not be canonicalized (${u.cwdError ?? "unresolved"}); scope membership cannot be determined`));
    } else if (governedScopes.has(u.canonicalCwd)) {
      cannotVerify.push(entry("A3", u.id, [u.id],
        `ADVISORY (not a violation): agent ${u.id} (${u.provider || "no provider"}) has no role suffix on its provider but is active in governed scope ${u.canonicalCwd} alongside role-declared agents [${governedScopes.get(u.canonicalCwd).sort().join(", ")}]. Provider names are the only role source the graph has; a briefed scout on a non-claude provider looks identical to an ungoverned stray until F015`,
        { advisory: true }));
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

  // A5 — split by evidence class. The delegation leg STAYS exit-3: a
  // ParentAgentId is a fact Paseo recorded, and a supervisor that spawned an
  // agent did so whatever its provider is named. The posture leg is demoted for
  // the same reason as A2 — it rests on the provider-suffix role vocabulary,
  // and on a pack-enforced seat the mode is not authority at all.
  for (const sup of agents.filter((a) => a.role === "supervisor")) {
    const targets = (delegateTargets.get(sup.id) ?? []).sort();
    if (targets.length > 0) {
      violations.push(entry("A5", sup.id, [sup.id, ...targets],
        `supervisor ${sup.id} parents delegation edge(s) to [${targets.join(", ")}]; the supervisor seat is observe-only and never orchestrates`));
    }
    if (sup.posture === "write") {
      cannotVerify.push(entry("A5", `${sup.id}:posture`, [sup.id],
        `ADVISORY (not a violation): supervisor ${sup.id} holds write-capable mode "${sup.mode}"; the supervisor seat is observe-only. ${
          sup.enforcement === "pack-enforced"
            ? "This seat is pack-enforced, so the hook — not the mode — is what actually denies the write"
            : "Role here is a provider-name suffix, which F015 records as an unreliable source"
        }`,
        { advisory: true }));
    } else if (sup.posture !== "read-only") {
      cannotVerify.push(entry("A5", `${sup.id}:posture`, [sup.id],
        `supervisor ${sup.id} posture is not derivable: ${modeNote(sup)}; observe-only cannot be confirmed`));
    }
  }

  // A6 — counts must never present a capped, partial, or EMPTY scan as a total.
  const scan = meta.scan;
  const scanShapeOk =
    scan !== null &&
    typeof scan === "object" &&
    Number.isFinite(scan?.listedTotal) &&
    Number.isFinite(scan?.scopedTotal) &&
    Number.isFinite(scan?.rendered) &&
    Number.isFinite(scan?.uninspected) &&
    typeof scan?.truncated === "boolean";
  if (!scanShapeOk) {
    cannotVerify.push(entry("A6", "(no-scan-metadata)", [],
      "meta.scan is absent or malformed, so meta.counts cannot be checked against the pre-cap population; counts must not be read as totals"));
  } else {
    // A scan of nothing must never read as a pass. The daemon listed agents
    // and the scope filter matched none of them: that is a mistyped --cwd, a
    // stale spelling, or a workspace nobody is working in — three different
    // answers, none of which is "the topology is clean".
    if (scan.scopedTotal === 0 && scan.listedTotal > 0) {
      violations.push(entry("A6", "empty-scope", [],
        `scope ${meta.scope ?? "(undeclared)"} matched 0 of ${scan.listedTotal} listed agents; an empty scan is not a clean topology — check the scope spelling, or use --all`));
    }
    // Nothing listed at all is a different statement: the daemon really is
    // empty, so there is no population to be wrong about, and no pass to give.
    if (scan.listedTotal === 0) {
      cannotVerify.push(entry("A6", "(empty-daemon)", [],
        "the daemon listed 0 agents, so no invariant had anything to evaluate; this is an empty result, not a verified-clean topology"));
    }
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

  // Canonicalize at ingest, before anything is compared: `ls` spells this
  // machine's directories `~/x` and `inspect` spells the same ones
  // `/Users/u/x`. One realpath per distinct spelling, memoized — three orders
  // of magnitude below the execFile fan-out below it.
  const listedAgents = Array.isArray(listed) ? listed : [];
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? DEFAULT_INSPECT_CONCURRENCY));
  const scopeRaw = options.all ? "" : normalizePaseoCwd(options.cwd ?? process.cwd());
  const canonicalCwds = await resolveCanonicalCwds(
    [...listedAgents.map((a) => normalizePaseoCwd(a.cwd)), scopeRaw],
    { concurrency },
  );
  const scopeCanonical = scopeRaw ? (canonicalCwds.get(scopeRaw)?.canonical ?? null) : null;

  // An agent whose cwd will not resolve cannot be proven in or out of scope. It
  // is decided on its raw spelling and REPORTED — the alternative, dragging
  // every unresolvable path on the host into one workspace's scope, would bury
  // the scope in agents that have nothing to do with it.
  const unresolvedCwds = [];
  const scoped = listedAgents.filter((a) => {
    const cwd = normalizePaseoCwd(a.cwd);
    const canonicalCwd = cwd ? (canonicalCwds.get(cwd)?.canonical ?? null) : null;
    if (cwd && !canonicalCwd && !options.all) {
      unresolvedCwds.push({ id: a.id, cwd, error: canonicalCwds.get(cwd)?.error ?? "unresolved" });
    }
    return inScope({ cwd, canonicalCwd }, { all: options.all, cwd: scopeRaw, scopeCanonical });
  });
  const capped = scoped.slice(0, Math.max(1, Math.floor(options.maxAgents ?? 100)));

  // Bounded fan-out: ParentAgentId only exists on inspect, so this is the cost.
  const details = new Array(capped.length);
  let cursor = 0;
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

  // `inspect` reports its own spelling of Cwd, so the spellings it introduces
  // are canonicalized too and merged into the same table.
  for (const [cwd, resolved] of await resolveCanonicalCwds(
    capped.map((_, i) => normalizePaseoCwd(details[i]?.Cwd ?? "")),
    { concurrency },
  )) {
    canonicalCwds.set(cwd, resolved);
  }

  const agents = capped.map((listedAgent, i) =>
    markStale(normalizeAgent(listedAgent, details[i], canonicalCwds), { staleAfterMs: options.staleAfterMs }),
  );
  const graph = buildGraph(agents, {
    daemon,
    scope: options.all ? "all" : (scopeCanonical ?? scopeRaw ?? process.cwd()),
  });
  // A capped scan must never read as a total: meta.counts describes the
  // RENDERED set, so the pre-cap population and the inspect shortfall are
  // published alongside it instead of collapsing into one boolean.
  const uninspected = agents.filter((a) => !a.inspectOk).length;
  graph.meta.scan = {
    listedTotal: listedAgents.length,
    scopedTotal: scoped.length,
    rendered: capped.length,
    truncated: scoped.length > capped.length,
    uninspected,
    // Scoped on a raw spelling because the path would not resolve. Published
    // rather than swallowed: a scope decision made without canonical identity
    // is exactly the class of miss this change exists to close.
    cwdUnresolved: unresolvedCwds.length,
    ...(unresolvedCwds.length > 0 ? { cwdUnresolvedDetail: unresolvedCwds.slice(0, 20) } : {}),
  };
  graph.meta.scopeCanonical = scopeCanonical;
  if (scopeRaw && !scopeCanonical) graph.meta.scopeResolveError = canonicalCwds.get(scopeRaw)?.error ?? "unresolved";
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
reported under cannotVerify with the concrete reason. Neither is unknown a
violation: A2, A3 and A5's posture leg report as advisories (cannotVerify with
"advisory": true) because they rest on the provider-name role vocabulary that
F015 owns, and A1's true-positive branch is vacuous until F015 gives roles a
source. A4, A5's delegation leg and A6 are fact-based and still exit 3.`;
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
