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
 * Role comes from the `harness.role` LABEL, swept server-side, with the
 * provider suffix as a cross-check (F015). `inspect` exposes no Labels field,
 * so the label is read the only way the daemon offers: one `ls --label
 * harness.role=<v>` per value of a CLOSED set, intersected by id — the shape
 * reconcile-observer.mjs already proved for retention. A closed set is not a
 * style choice: the label channel has exact-match/AND/last-wins and NO
 * existence or negation selector, so "who has no role?" is only answerable as
 * scoped minus the union of the per-value results. A key-only selector FAILS
 * OPEN (measured: `--label harness.role` returned all 200 agents), which is
 * why every selector goes through validateLabelSelector and a malformed one
 * throws instead of querying.
 *
 * The two sources are not interchangeable and A7 keeps them apart. On a
 * pack-enforced claude-* seat the suffix is a MECHANISM (it selects the
 * provider config that sets PASEO_CLAUDE_ROLE and arms the hook), so a label
 * that disagrees with it is a violation: the governance record disagrees with
 * the mechanism. On any other provider the suffix is hand-made TEXT, so
 * agreement proves nothing and disagreement is only cannotVerify. A label on
 * an unenforced seat is a CLAIM, accepted for inclusion in the audited
 * population and never as authority — a false claim fails safe by adding
 * scrutiny. Anything with neither source renders as `unknown` with no
 * delegation edge: in a governance view a confident wrong edge is worse than
 * a blank one.
 *
 *   node scripts/governance-graph.mjs                 # scope: cwd, to stdout
 *   node scripts/governance-graph.mjs --all --out g.json
 *   node scripts/governance-graph.mjs --serve 7788    # viewer + live JSON
 *   node scripts/governance-graph.mjs --assert        # invariants A1–A8, exit 3 on violation
 */

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_ROLE_VALUES,
  isEntrypoint,
  leadWriteEnabled,
  normalizePaseoCwd,
  resolveCanonicalCwds,
  resolvePaseoExec,
  validateLabelSelector,
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

/**
 * The base agent listing. EVERY label query is this argv plus one `--label`,
 * because the sweep answers a set-difference question ("in scope and in no
 * role set") and a difference between two differently-postured populations is
 * arithmetic on two different fleets.
 *
 * Both call sites SPREAD this constant, so the two postures cannot drift apart
 * by editing one of them — that is the point of the constant, not a comment
 * asking anyone to remember. What it does not prevent is a call site that
 * stops spreading it and hardcodes its own argv: give the base list `-a` alone
 * and archived agents appear in the population but in no role result, landing
 * as residue nobody can fix; give the label queries `-a` alone and archived
 * agents acquire records the base list never asked about. Changing the posture
 * of BOTH (here, once) is fine and is the supported way to do it.
 * test/governance-graph.test.mjs pins the value and the derivation.
 */
export const BASE_LIST_ARGS = Object.freeze(["ls", "-g"]);

/** The authority label. Its VALUES are closed — see lib-common HARNESS_ROLE_VALUES. */
export const ROLE_LABEL_KEY = "harness.role";

/**
 * F015 SCHEMA EPOCH — the instant the two-layer taxonomy became mandatory.
 *
 * Recorded as an absolute constant and compared against `inspect.CreatedAt`,
 * which is the only absolute creation time the daemon publishes (`ls` carries
 * a relative "7 hours ago" string that cannot be compared to anything). It is
 * chosen AFTER every agent that existed when F015 landed and BEFORE any
 * compliant creation, so no pre-existing agent is ever judged by a rule that
 * did not exist when it was created — and no new one escapes.
 *
 * `harness.schema=v2` is a POSITIVE marker only and must never become this
 * test: an agent created by a non-compliant caller carries no marker at all,
 * so absence would read as "pre-epoch" for exactly the population the residue
 * clause exists to catch.
 */
export const SCHEMA_EPOCH = "2026-08-31T12:00:00Z";
export const SCHEMA_EPOCH_MS = Date.parse(SCHEMA_EPOCH);

/**
 * Provider suffix → role. Derived from the one closed vocabulary rather than
 * retyped: the suffix and the label are two projections of ONE axis (the
 * provider config that carries a suffix is the config that sets
 * PASEO_CLAUDE_ROLE), so a suffix this file recognized and the label vocabulary
 * did not would be a role that can be claimed by a provider name and never
 * recorded.
 */
const ROLE_SUFFIXES = HARNESS_ROLE_VALUES.map((role) => [role, role]);

/**
 * Sweep `harness.role` across its closed value set and return an id → role map.
 *
 * INHERITED SHAPE (reconcile-observer.mjs:463-499, which proved it on
 * retention): one server-side query per value, membership by id, and a
 * "did every query succeed?" gate. Cost is fixed at |values| spawns — three —
 * regardless of fleet size, because the daemon does the filtering.
 *
 * FAIL-CLOSED, and the direction matters. `rolesKnown` is false unless EVERY
 * query returned a list. A single failed query makes some agents look
 * unlabeled, and "unlabeled" is exactly what the residue clause turns into a
 * violation — so a transient CLI error would manufacture violations across a
 * whole scope. When rolesKnown is false the caller must ignore this map
 * entirely rather than use the part of it that arrived.
 *
 * An id appearing under two different values is a daemon inconsistency, not a
 * tie to break: one key holds one value, so `last-wins` here would be picking
 * a winner between two answers that cannot both be true. It downgrades the
 * whole sweep instead.
 */
export async function sweepRoleLabels(paseoJson, budget, options = {}) {
  const key = options.roleLabelKey ?? ROLE_LABEL_KEY;
  const values = options.roleValues ?? HARNESS_ROLE_VALUES;
  // Composed and validated BEFORE any query: a malformed key must never reach
  // a daemon whose answer to it is the whole fleet.
  const selectors = values.map((value) => [value, validateLabelSelector(`${key}=${value}`)]);

  const byId = new Map();
  const errors = [];
  let rolesKnown = true;
  for (const [value, selector] of selectors) {
    try {
      const rows = await paseoJson([...BASE_LIST_ARGS, "--label", selector], budget());
      if (!Array.isArray(rows)) throw new Error("label query did not return a list");
      for (const row of rows) {
        const id = row?.id ?? row?.Id;
        if (!id) continue;
        const seen = byId.get(id);
        if (seen !== undefined && seen !== value) {
          rolesKnown = false;
          errors.push(`${id} answered to both ${key}=${seen} and ${key}=${value}; one key holds one value, so the sweep is inconsistent`);
          continue;
        }
        byId.set(id, value);
      }
    } catch (error) {
      rolesKnown = false;
      errors.push(`${selector}: ${String(error?.message ?? error)}`);
    }
  }
  return { key, values: [...values], byId, rolesKnown, errors };
}

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
 *
 * `roleLabels` is the sweep's id → role map, and it is the PRIMARY role
 * source; the provider suffix is the fallback for a seat that carries no
 * record, and `roleSource` says which one answered so no downstream check has
 * to guess. Callers that did not sweep pass nothing and get exactly the
 * pre-F015 behaviour — a graph built without a sweep never claims a record.
 */
export function normalizeAgent(listed, detail, canonicalMap = null, roleLabels = null) {
  const d = detail ?? {};
  const provider = d.Provider ?? String(listed.provider ?? "").split("/")[0] ?? "";
  const model = d.Model ?? String(listed.provider ?? "").split("/").slice(1).join("/");
  const cwd = normalizePaseoCwd(d.Cwd ?? listed.cwd ?? "");
  const canonicalEntry = cwd ? canonicalMap?.get(cwd) : undefined;
  const availableModes = Array.isArray(d.AvailableModes) ? d.AvailableModes : [];
  const mode = d.Mode ?? null;
  const id = listed.id ?? d.Id;
  const providerRole = roleFromProvider(provider);
  const labelRole = roleLabels?.get(id) ?? null;
  return {
    id,
    shortId: listed.shortId ?? String(listed.id ?? d.Id ?? "").slice(0, 7),
    name: d.Name ?? listed.name ?? "",
    provider,
    model,
    role: labelRole ?? providerRole,
    labelRole,
    providerRole,
    roleSource: labelRole ? "label" : providerRole === "unknown" ? "none" : "provider",
    // Absolute, from inspect: the only creation time that can be compared to
    // the schema epoch. `ls` publishes a relative string and nothing else.
    createdAt: d.CreatedAt ?? null,
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
          // The two sources, kept apart on purpose: A7 compares them and the
          // residue clause asks only whether a RECORD exists.
          labelRole: agent.labelRole ?? null,
          providerRole: agent.providerRole ?? roleFromProvider(agent.provider),
          roleSource: agent.roleSource ?? (agent.labelRole ? "label" : agent.role === "unknown" ? "none" : "provider"),
          createdAt: agent.createdAt ?? null,
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
  A3: "missing-role-record-in-governed-scope",
  A4: "peer-orchestrates",
  A5: "supervisor-not-observe-only",
  A6: "count-integrity",
  A7: "role-record-vs-mechanism",
  A8: "unrecorded-orchestrator",
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
      labelRole: n.data?.labelRole ?? null,
      providerRole: n.data?.providerRole ?? roleFromProvider(n.data?.provider),
      roleSource: n.data?.roleSource ?? "provider",
      createdAt: n.data?.createdAt ?? null,
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
  // VACUUM CLOSED (F015, 2026-08-31 — this comment replaces the STATED VACUUM
  // that stood here). "role === peer AND unenforced" used to be empty on every
  // fleet the pack could produce, because role was read off a provider suffix
  // that only the pack-enforced claude-* providers carry: the true-positive
  // branch was unreachable in production and its only control was a hand-built
  // `omp-peer` no shipped config emits. Roles now come from the `harness.role`
  // sweep, so an omp/agy/codex seat labelled `peer` lands in this set — the
  // intersection is populated, the branch is reachable, and it is proven at the
  // process boundary by the two-running-unenforced-peers control in
  // test/governance-graph-assert.test.mjs (real CLI, real collection, exit 3).
  // The suffix-built fixture survives as a SECONDARY control for the fallback
  // path only. Do not loosen the three clauses above on the grounds that A1 is
  // quiet: quiet is now a finding about the fleet, not about the check.
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
  // A2 — STAYS ADVISORY, and F015 is no longer the reason. Role now has a
  // record, but the thing A2 wants to conclude — "this lead is writing" —
  // still rests on Mode, and on a pack-enforced seat Mode is not authority in
  // either direction. On an unenforced lead the mode does mean something, yet
  // "the lead seat accepts, it does not write" is a doctrine about how the
  // pack's own leads are run, not a fact about a seat somebody else labelled.
  // Failing a morning gate on either would teach an operator to stop reading
  // exit 3, which costs more than the check is worth.
  // -------------------------------------------------------------------------
  const leadWrite = nodes.find((n) => n?.id === "run-policy")?.data?.policy?.leadWrite ?? "undeclared";
  for (const lead of agents.filter((a) => a.role === "lead")) {
    if (lead.posture === "write") {
      cannotVerify.push(entry("A2", lead.id, [lead.id],
        `ADVISORY (not a violation): lead ${lead.id} holds write-capable mode "${lead.mode}"; the lead seat accepts, it does not write. ${
          lead.enforcement === "pack-enforced"
            ? "This seat is pack-enforced, so the mode is not its authority — the hook is"
            : `Role here is ${lead.roleSource === "label" ? "a harness.role record, which is a claim on an unenforced provider and never an authority grant" : "a provider-name suffix, which is hand-made text and carries no mechanism"}`
        }. leadWrite is ${leadWrite} in THIS collector's environment, which says nothing about the environment ${lead.id} runs in`,
        { advisory: true }));
    } else if (lead.posture !== "read-only") {
      cannotVerify.push(entry("A2", lead.id, [lead.id],
        `lead ${lead.id} posture is not derivable: ${modeNote(lead)}; read-only cannot be confirmed`));
    }
  }

  // -------------------------------------------------------------------------
  // A3 — THE RESIDUE CLAUSE. Every agent in a governed scope must carry a
  // `harness.role` record; the ones that do not are the residue of the
  // set-difference the sweep exists to compute (scoped MINUS the union of the
  // per-value results), and after the schema epoch that residue is a violation.
  //
  // This is F015's actual teeth, and it is the only check here that can fire on
  // an agent nobody labelled — which is precisely the population that evaded
  // every other mechanism: all nine offenders measured on 2026-08-31 were
  // children of an UNARMED creator, so the create-time gate never saw them, and
  // all nine omitted `harness.owner`, so the reconciler's cohort never saw them
  // either. The graph scopes by canonical cwd and sees all nine.
  //
  // A SCHEMA EPOCH, NOT A BACKFILL. An agent created before the taxonomy
  // existed cannot be guilty of omitting it, and relabelling 140 live agents
  // from an unarmed session would launder history through the very hole this
  // closes. Pre-epoch agents are a DECLARED cohort: named once per scope, as an
  // advisory, never as a violation.
  //
  // Three fail-closed guards, each of which would otherwise manufacture
  // violations wholesale rather than miss them:
  //   NO SWEEP    a graph built without a sweep knows nothing about labels.
  //   SWEEP FAILED  every agent would look unlabelled. Suppress, don't accuse.
  //   NO CreatedAt  one transient "Agent not found" was observed live; an agent
  //                 whose inspect failed has no epoch side, so it has no verdict.
  // -------------------------------------------------------------------------
  // MEMBERSHIP vs ATTRIBUTION, and they are deliberately different sets.
  //
  // A scope is GOVERNED when the pack operates in it at all, which a
  // provider-derived role establishes just as well as a record — narrowing
  // membership to record-carrying agents would let a post-epoch stray in a
  // scope whose other seats happen to be unlabelled escape the clause entirely.
  //
  // But the agents NAMED as the governance a stray sits alongside must be
  // record-carrying only. Sourcing that list from the effective role listed the
  // same unlabelled agent as "role-declared" and inside the no-record cohort
  // one sentence apart — a line that reads as self-refuting to the operator it
  // is written for.
  const governedScopes = new Map();
  const recordedByScope = new Map();
  for (const a of agents) {
    if (a.role === "unknown" || !a.canonicalCwd) continue;
    if (!governedScopes.has(a.canonicalCwd)) governedScopes.set(a.canonicalCwd, []);
    governedScopes.get(a.canonicalCwd).push(a.id);
    if (a.roleSource !== "label") continue;
    if (!recordedByScope.has(a.canonicalCwd)) recordedByScope.set(a.canonicalCwd, []);
    recordedByScope.get(a.canonicalCwd).push(a.id);
  }
  /** Who actually holds a record here — or an explicit statement that nobody does. */
  const governedBy = (scope) => {
    const recorded = recordedByScope.get(scope);
    return recorded?.length
      ? `alongside record-carrying agents [${[...recorded].sort().join(", ")}]`
      : "in a scope whose governance is provider-derived only — no agent here carries a record";
  };
  const sweep = meta.roleSweep;
  const sweepUsable = sweep !== null && typeof sweep === "object" && sweep.known === true;
  const sweptValues = sweepUsable ? (sweep.values ?? []).join(", ") : "";
  const unrecorded = agents.filter((a) => a.roleSource !== "label");
  if (sweep === null || typeof sweep !== "object") {
    if (unrecorded.length > 0) {
      cannotVerify.push(entry("A3", "(no-role-sweep)", [],
        `meta.roleSweep is absent, so no agent's ${ROLE_LABEL_KEY} record was read and the residue clause cannot run; ${unrecorded.length} agent(s) show a provider-derived or absent role only`));
    }
  } else if (sweep.known !== true) {
    cannotVerify.push(entry("A3", "(sweep-failed)", [],
      `the ${ROLE_LABEL_KEY} sweep did not complete (${(sweep.errors ?? []).join("; ") || "no reason recorded"}); with an incomplete sweep every agent looks unlabelled, so the residue clause is suppressed rather than allowed to accuse a whole scope, and roles fall back to the provider suffix`));
  } else {
    const declaredByScope = new Map();
    for (const u of unrecorded) {
      if (!u.cwd) {
        cannotVerify.push(entry("A3", u.id, [u.id],
          `agent ${u.id} answers to no ${ROLE_LABEL_KEY} value in {${sweptValues}} and carries no cwd signal; whether it sits inside a governed scope cannot be determined`));
      } else if (!u.canonicalCwd) {
        cannotVerify.push(entry("A3", u.id, [u.id],
          `agent ${u.id} answers to no ${ROLE_LABEL_KEY} value in {${sweptValues}} and its cwd ${u.cwd} could not be canonicalized (${u.cwdError ?? "unresolved"}); scope membership cannot be determined`));
      } else if (!governedScopes.has(u.canonicalCwd)) {
        continue; // nobody governs that directory; not this gate's business
      } else {
        const createdMs = Date.parse(u.createdAt ?? "");
        if (!Number.isFinite(createdMs)) {
          cannotVerify.push(entry("A3", u.id, [u.id],
            `agent ${u.id} answers to no ${ROLE_LABEL_KEY} value in {${sweptValues}} and has no readable CreatedAt (${u.createdAt ?? "absent — inspect did not answer"}); the schema epoch ${SCHEMA_EPOCH} cannot be applied to it`));
        } else if (createdMs > SCHEMA_EPOCH_MS) {
          violations.push(entry("A3", u.id, [u.id],
            `agent ${u.id} (${u.provider || "no provider"}) was created ${u.createdAt}, after the F015 schema epoch ${SCHEMA_EPOCH}, and answers to no ${ROLE_LABEL_KEY} value in {${sweptValues}} while running in governed scope ${u.canonicalCwd}, ${governedBy(u.canonicalCwd)}; every agent created in a governed scope carries an authority record`));
        } else {
          if (!declaredByScope.has(u.canonicalCwd)) declaredByScope.set(u.canonicalCwd, []);
          declaredByScope.get(u.canonicalCwd).push(u.id);
        }
      }
    }
    // One line per scope, not one per seat: a pre-epoch cohort is a property of
    // the fleet's history, and repeating it per agent is the flood that teaches
    // an operator to stop reading the output.
    for (const scope of [...declaredByScope.keys()].sort()) {
      const cohort = declaredByScope.get(scope).sort();
      cannotVerify.push(entry("A3", `${scope}:pre-epoch`, cohort,
        `ADVISORY (not a violation): ${cohort.length} agent(s) in governed scope ${scope}, ${governedBy(scope)}, answer to no ${ROLE_LABEL_KEY} value in {${sweptValues}} and were created before the F015 schema epoch ${SCHEMA_EPOCH} — the DECLARED cohort. They are audited, not accused: the taxonomy did not exist when they were created, and relabelling them now from an unarmed session would launder history. They age out as they are archived; no backfill is planned`,
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

  // A5 — split by evidence class, and then the delegation leg splits again by
  // LIVENESS, for the reason A1 already documents above.
  //
  // A ParentAgentId is a fact Paseo recorded, so a supervisor that spawned an
  // agent did so whatever its provider is named — that does not change here.
  // What changes is what exit 3 is FOR. It means "stop, the topology is wrong,
  // fix it before dispatching". On a running supervisor that is actionable:
  // cancel the children, retire the seat. On a CLOSED one there is no action at
  // all — the edge is finished history, and no operation on today's topology can
  // clear it. Left as a violation it makes the morning gate red forever, and a
  // gate that can never be green stops being read inside a week. Measured
  // 2026-09-01: one closed supervisor from 2026-08-22 held `--assert` at exit 3
  // on every scope.
  //
  // Demoted, NOT dropped. The advisory keeps the same evidence and says plainly
  // that the edge really happened — the F015 DECLARED-cohort posture: audited,
  // not accused, ageing out as the agent is archived. Deleting it instead would
  // launder history, which is the opposite failure.
  //
  // The live branch is load-bearing and has a positive control through the real
  // CLI in test/governance-graph-assert.test.mjs. Without it this split is
  // indistinguishable from switching A5's delegation leg off.
  for (const sup of agents.filter((a) => a.role === "supervisor")) {
    const targets = (delegateTargets.get(sup.id) ?? []).sort();
    if (targets.length > 0) {
      if (running(sup)) {
        violations.push(entry("A5", sup.id, [sup.id, ...targets],
          `supervisor ${sup.id} parents delegation edge(s) to [${targets.join(", ")}]; the supervisor seat is observe-only and never orchestrates`));
      } else {
        cannotVerify.push(entry("A5", `${sup.id}:closed-delegation`, [sup.id, ...targets],
          `ADVISORY (not a violation): supervisor ${sup.id} (status ${sup.status}) parents delegation edge(s) to [${targets.join(", ")}]. The edge is real and the seat did orchestrate — this is recorded, not excused. It is an advisory because the supervisor is not running, so no action on today's topology can clear it; blocking on finished history would hold this gate red permanently and teach its reader to ignore it. It ages out when the agent is archived`,
          { advisory: true }));
      }
    }
    if (sup.posture === "write") {
      cannotVerify.push(entry("A5", `${sup.id}:posture`, [sup.id],
        `ADVISORY (not a violation): supervisor ${sup.id} holds write-capable mode "${sup.mode}"; the supervisor seat is observe-only. ${
          sup.enforcement === "pack-enforced"
            ? "This seat is pack-enforced, so the hook — not the mode — is what actually denies the write"
            : `Role here is ${sup.roleSource === "label" ? "a harness.role record, which is a claim on an unenforced provider and never an authority grant" : "a provider-name suffix, which is hand-made text and carries no mechanism"}`
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

  // -------------------------------------------------------------------------
  // A7 — the governance RECORD versus the MECHANISM, and the asymmetry between
  // them is the whole rule.
  //
  // On a pack-enforced seat the provider suffix is not a name: `claude-peer`
  // selects the provider config that sets PASEO_CLAUDE_ROLE, which is what arms
  // the PreToolUse hook. So the suffix is the mechanism actually in force, and
  // a `harness.role` label that disagrees with it means the record the fleet is
  // audited by describes an agent that is not the one running. That is a fact
  // the graph carries about two sources it can both read → exit 3.
  //
  // On any other provider the suffix is hand-made text (`omp-peer` is a name
  // somebody typed) and the label is a claim. Two claims disagreeing is not
  // evidence that either is false, and there is no third source to break the
  // tie → cannotVerify. The failure this asymmetry prevents is calling an
  // unenforced seat's naming choice a governance violation.
  //
  // NEVER "wrong authority": this rule reports a DISAGREEMENT. It does not know
  // which side is right, and a message that implies it does would send someone
  // to relabel the agent when the provider was the thing that was wrong.
  // -------------------------------------------------------------------------
  for (const a of agents) {
    if (a.roleSource !== "label" || a.labelRole === null) continue;
    if (a.providerRole === "unknown" || a.providerRole === a.labelRole) continue;
    if (a.enforcement === "pack-enforced") {
      violations.push(entry("A7", a.id, [a.id],
        `agent ${a.id} records ${ROLE_LABEL_KEY}=${a.labelRole} but runs on pack-enforced provider ${a.provider}, which arms the hook as ${a.providerRole}; the governance record disagrees with the mechanism actually bounding this seat — one of the two is wrong and this check does not know which`));
    } else {
      cannotVerify.push(entry("A7", a.id, [a.id],
        `agent ${a.id} records ${ROLE_LABEL_KEY}=${a.labelRole} while its provider ${a.provider} is suffixed ${a.providerRole}; on a ${a.enforcement} provider the suffix is hand-made text and not a mechanism, so the disagreement proves nothing about either side`));
    }
  }

  // THE THIRD STATE, and it was structurally invisible before this: a
  // pack-enforced seat whose record does not CONFIRM the mechanism.
  //
  // The loop above can only see a record that holds one of the swept values.
  // A record holding anything else answers to no query, so the sweep reports
  // the seat exactly as it reports a seat with no label at all — and A7 fell
  // straight through, emitting nothing. Two live instances exist on this host
  // right now (`claude-peer` seats carrying `harness.role=scout`, measured
  // 2026-08-31): pack-enforced, contradicted by their own record, and silent.
  //
  // WHY THIS IS A cannotVerify AND NOT A VIOLATION. "The record disagrees with
  // the mechanism" is a claim this check cannot make about this population,
  // because the population is a MIXTURE: of the 12 pack-enforced seats in this
  // repo's scope with no swept record, 2 carry a wrong value and 10 carry no
  // label at all. Calling all 12 a disagreement would be a false statement
  // about 10 of them — manufacturing, which the same rule that forbids
  // unknown-is-a-pass forbids in this direction too. The missing-record case
  // already has an owner with the evidence to judge it: A3 decides it on the
  // schema epoch, and post-epoch it is an exit-3 violation there. What this
  // entry adds is the fact A3 does not carry — that on THESE seats the suffix
  // is a live mechanism, so an unconfirmed record is not merely a gap in the
  // paperwork, it is paperwork that fails to describe a bound that is in force.
  //
  // The ambiguity is not laziness and it is not closable by asking harder: the
  // channel has no existence selector and no negation, a key-only selector
  // returns the whole fleet, and the out-of-vocabulary set is OPEN — probing
  // the Layer-2 disposition vocabulary in this key returns 0 on this host,
  // because the live wrong values are informal short names — scout, not the
  // repository-scout the vocabulary actually holds. See docs/governance-graph.md.
  // (Written without quoting the vocabulary token on purpose: the
  // no-second-literal-copy scan in test/lib-common.test.mjs reads a quoted one
  // as a re-introduced copy, and it is right to.)
  //
  // Gated on the same completed sweep as A3: with a failed or absent sweep
  // every pack-enforced seat looks unconfirmed, and one timed-out query would
  // print this line for the entire fleet.
  if (sweepUsable) {
    const unconfirmedByScope = new Map();
    for (const a of agents) {
      if (a.enforcement !== "pack-enforced" || a.roleSource === "label") continue;
      // No suffix means no mechanism asserted, so there is nothing to confirm.
      if (a.providerRole === "unknown") continue;
      const key = a.canonicalCwd ?? (a.cwd ? `unresolved:${a.cwd}` : "(no-scope)");
      if (!unconfirmedByScope.has(key)) unconfirmedByScope.set(key, []);
      unconfirmedByScope.get(key).push(a);
    }
    // One line per scope, like A1's pack-enforced note: the blindness is a
    // property of the scope's population, not news about each seat in it.
    for (const scope of [...unconfirmedByScope.keys()].sort()) {
      const seats = unconfirmedByScope.get(scope);
      cannotVerify.push(entry("A7", `${scope}:unconfirmed`, seats.map((a) => a.id),
        `${seats.length} pack-enforced seat(s) in scope ${scope} answer to no ${ROLE_LABEL_KEY} value in {${sweptValues}}, so their record does not confirm the mechanism that bounds them (${seats.map((a) => `${a.id}(${a.provider} arms the hook as ${a.providerRole})`).sort().join(", ")}). On these providers the suffix IS the mechanism, so the record ought to name the same role. Whether each seat is UNLABELLED or carries a value outside the closed set is not decidable here — the label channel has no existence selector and no negation, and a key-only selector returns the whole fleet — so this is reported as blindness rather than as a disagreement. The missing-record half is A3's verdict, and after the schema epoch A3 makes it an exit-3 violation`));
    }
  }

  // A8 — an agent that ORCHESTRATES while carrying no authority record.
  //
  // This is the gap between A4 and A5. Those two ask "is this orchestrator the
  // wrong ROLE?" — a peer, a supervisor — and both need a role before they can
  // answer. The seat that matters most here has none: a standing Lead on a bare
  // `claude` provider carries no suffix the pack reads and no `harness.role`
  // label, so its role resolves to `unknown` and every role-keyed rule falls
  // straight through it. It is invisible to the entire tier while being the one
  // seat whose children arrive unaccounted for.
  //
  // So this rule asks nothing about role. It is built from two facts the graph
  // can both read: a recorded `ParentAgentId` (this agent created that one) and
  // a completed role sweep that returned no record for it. Orchestration is an
  // act, not a title, and an act with no authority record behind it is exactly
  // the thing the label schema exists to make impossible.
  //
  // WHY IT MATTERS OPERATIONALLY: the create-time label gate binds by CREATOR.
  // It fires only when the seat calling create_agent is itself armed with
  // PASEO_CLAUDE_ROLE. An unrecorded orchestrator never arms it, so its
  // children arrive with no record either — which A3 then reports one scope at
  // a time, as anonymous strays, with no way to say where they came from. This
  // entry supplies the attribution A3 cannot: which seat made them, from
  // ParentAgentId, not from sharing a directory.
  //
  // ADVISORY, NOT EXIT 3, and this is the part not to "tidy up" later. Running
  // a standing Lead on a bare `claude` seat is a legitimate way to work — it is
  // how most of this repo was built — and a rule that turns the morning gate red
  // on somebody's ordinary workflow is a rule that gets ignored, taking the rest
  // of the gate with it. That failure has a catalog entry (AP-05) and this pack
  // has now paid for it twice in one day. Prevention is also not on the table:
  // measured 2026-09-01, disabling the base provider neither holds (the daemon
  // rewrites it) nor is acceptable (it breaks every ungoverned project on the
  // host). Detection is what is actually available, so detection is what this
  // ships, and it says so instead of implying a bound it does not have.
  //
  // GUARDED ON THE SWEEP for the same reason A3's residue clause is: with an
  // incomplete sweep every agent looks unlabelled, and this rule would accuse
  // every orchestrator on the fleet at once.
  //
  // MEASURED COVERAGE, and the limit is bigger than the rule. On this host
  // 2026-09-01: 139 agents, 9 `delegates` edges, all 9 from `claude-lead` or
  // `claude-supervisor` seats — A8 fires ZERO times. That is a finding about the
  // fleet, not evidence the check works, and it must not be read as coverage.
  //
  // The limit: an edge exists only where Paseo recorded a `ParentAgentId`, which
  // it does for `create_agent` and NOT for an agent a human opened from the app
  // or the CLI. Checked directly the same day — the three unlabelled post-epoch
  // strays that motivated this rule (and the standing Lead itself) all report
  // `ParentAgentId: null`. They were opened by a person, so no edge exists and
  // A8 cannot see them at all.
  //
  // So A8 closes the agent-created half and the human-created half stays open,
  // permanently, at this layer: the graph cannot know who opened a window. A3
  // still REPORTS those strays — what is unavailable is attribution, and no
  // amount of inference over shared directories would make it available, only
  // make it look available. Recorded as an upstream ask (a created-by field),
  // not worked around.
  if (sweepUsable) {
    for (const source of [...delegateTargets.keys()].sort()) {
      const orchestrator = byId.get(source);
      if (!orchestrator) continue;
      // ONE guard, and it covers both cases on purpose. A role that is known —
      // from a label OR from a provider suffix — already has an owner: A4 for a
      // peer, A5 for a supervisor, and a recorded lead orchestrating is the
      // intended shape. Reporting any of them here would bill one seat to two
      // rules and inflate every count downstream.
      //
      // A `roleSource === "label"` guard alongside this one is REDUNDANT and was
      // removed after a mutation probe survived it: a label puts its value into
      // `role`, so a labelled agent is never `unknown` and the second guard
      // could never be the one that fired. A guard no mutation can kill is not a
      // guard, it is a comment that costs a branch.
      if (orchestrator.role !== "unknown") continue;
      const targets = delegateTargets.get(source).sort();
      const unrecordedKids = targets.filter((id) => byId.get(id)?.roleSource !== "label");
      const inherited = unrecordedKids.length > 0
        ? `${unrecordedKids.length} of the ${targets.length} agent(s) it created carry no ${ROLE_LABEL_KEY} record either [${unrecordedKids.sort().join(", ")}]`
        : `every agent it created does carry a record, so something else labelled them — the gate did not fire from here`;
      cannotVerify.push(entry("A8", source, [source, ...targets],
        `ADVISORY (not a violation): agent ${source} on ${orchestrator.provider || "(no provider)"} (${orchestrator.enforcement}) parents delegation edge(s) to [${targets.join(", ")}] while answering to no ${ROLE_LABEL_KEY} value in {${sweptValues}}. Orchestration is an act, and this one has no authority record behind it. The create-time label gate binds by CREATOR, so an unarmed creator produces unaccounted children: ${inherited}. Running this seat on claude-lead arms the gate for everything it creates afterwards; nothing here can force that, which is why this is reported and not denied`,
        { advisory: true }));
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
    listed = await retryWithBackoff(() => paseoJson([...BASE_LIST_ARGS], budget()), {
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

  // Role records, swept server-side: a fixed 3 spawns, and the ONLY way to read
  // a label — inspect carries none. Not fatal: a failed sweep is reported as
  // rolesKnown=false and the assert layer suppresses the residue clause rather
  // than accusing a scope of an omission the query never proved.
  const roleSweep = await sweepRoleLabels(paseoJson, budget, options);

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

  // An untrusted sweep is not consulted at all: using the part of a partial
  // answer that happened to arrive is how "some agents look unlabelled"
  // becomes "these agents are unlabelled".
  const roleLabels = roleSweep.rolesKnown ? roleSweep.byId : null;
  const agents = capped.map((listedAgent, i) =>
    markStale(normalizeAgent(listedAgent, details[i], canonicalCwds, roleLabels), { staleAfterMs: options.staleAfterMs }),
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
  graph.meta.roleSweep = {
    key: roleSweep.key,
    values: roleSweep.values,
    known: roleSweep.rolesKnown,
    labeled: roleSweep.rolesKnown ? roleSweep.byId.size : 0,
    errors: roleSweep.errors,
  };
  graph.meta.schemaEpoch = SCHEMA_EPOCH;
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
  --assert         evaluate topology invariants A1–A8 over the collected graph
                   and print { ok, violations, cannotVerify, meta }
  --help, -h       this text

Assert exit codes:
  0  no violations (cannotVerify may be non-empty — reported, not a failure)
  3  violations found
  2  usage or collection error ({ ok:false, code, message } on stdout)

Invariants: A1 one-writer-per-scope, A2 writer-is-acceptor, A3 missing-role-
record in governed scope (the F015 residue clause), A4 peer-orchestrates, A5
supervisor-not-observe-only, A6 count-integrity, A7 role-record-vs-mechanism.
Roles are swept from the harness.role label (${ROLE_LABEL_KEY}=<value> per
value of a closed set) with the provider suffix as cross-check.

Unknown is never pass: a signal the graph does not carry is reported under
cannotVerify with the concrete reason. Neither is unknown a violation: A2 and
A5's posture leg report as advisories (cannotVerify with "advisory": true)
because they read Mode, which is not authority on a pack-enforced seat, and A3
reports the pre-epoch DECLARED cohort as one advisory per scope because the
taxonomy did not exist when those agents were created. A1, A3's post-epoch
branch, A4, A5's delegation leg, A6 and A7's pack-enforced leg are fact-based
and exit 3. Schema epoch: ${SCHEMA_EPOCH}.`;
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
