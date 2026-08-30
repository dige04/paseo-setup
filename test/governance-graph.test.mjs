import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildGraph,
  collectGraph,
  enforcementClass,
  inScope,
  markStale,
  normalizeAgent,
  parseArgs,
  providerFamily,
  roleFromProvider,
} from "../scripts/governance-graph.mjs";

// ---------------------------------------------------------------------------
// Role derivation. `inspect` carries no Labels field, so the provider name is
// the only source — anything else must stay unknown rather than be guessed.
// ---------------------------------------------------------------------------

assert.equal(roleFromProvider("claude-lead"), "lead");
assert.equal(roleFromProvider("claude-lead/claude-opus-5"), "lead");
assert.equal(roleFromProvider("pi-peer"), "peer");
assert.equal(roleFromProvider("codex-supervisor"), "supervisor");
assert.equal(roleFromProvider("supervisor"), "supervisor");
assert.equal(roleFromProvider("claude"), "unknown", "a bare provider declares no role");
assert.equal(roleFromProvider("claude/claude-opus-5"), "unknown");
assert.equal(roleFromProvider("codex"), "unknown");
assert.equal(roleFromProvider(undefined), "unknown");
assert.equal(roleFromProvider("misleading"), "unknown");

// ---------------------------------------------------------------------------
// Provider family and enforcement class. Role says what a seat is FOR;
// enforcement says whether its Mode means anything, and the two are read off
// opposite ends of the same provider string.
// ---------------------------------------------------------------------------

assert.equal(providerFamily("claude-peer"), "claude");
assert.equal(providerFamily("claude-lead/claude-opus-5"), "claude");
assert.equal(providerFamily("omp/google-antigravity/gemini-3.7-flash"), "omp");
assert.equal(providerFamily("omp-peer"), "omp");
assert.equal(providerFamily("codex"), "codex");

// The pack's own three providers set PASEO_CLAUDE_ROLE, which arms the hook.
assert.equal(enforcementClass("claude-peer"), "pack-enforced");
assert.equal(enforcementClass("claude-lead/claude-opus-5"), "pack-enforced");
assert.equal(enforcementClass("claude-supervisor"), "pack-enforced");
// Documented as bounded by prompt + session mode only.
assert.equal(enforcementClass("omp/google-antigravity/gemini-3.7-flash"), "unenforced");
assert.equal(enforcementClass("agy"), "unenforced");
assert.equal(enforcementClass("codex"), "unenforced");
// Bare `claude` sets no role env in the pack's config, but an operator's own
// config might; unproven either way is `unknown`, never a convenient guess.
assert.equal(enforcementClass("claude"), "unknown");
assert.equal(enforcementClass("grok"), "unknown");
assert.equal(enforcementClass(""), "unknown");
assert.equal(enforcementClass(undefined), "unknown");

// ---------------------------------------------------------------------------
// Normalization across Paseo's two casings: `ls` is lowercase, `inspect` is
// PascalCase, and only `inspect` carries ParentAgentId.
// ---------------------------------------------------------------------------

const listed = { id: "a1", shortId: "a1", provider: "claude-peer/claude-sonnet-5", status: "running", cwd: "~/proj" };
const detail = {
  Id: "a1", Name: "T-1 fix", Provider: "claude-peer", Model: "claude-sonnet-5",
  Status: "Running", Mode: "acceptEdits", Cwd: "/home/u/proj",
  UpdatedAt: "2026-08-20T00:00:00.000Z", ParentAgentId: "lead-1", PendingPermissions: [],
  AvailableModes: [{ id: "plan", label: "Plan Mode" }, { id: "acceptEdits", label: "Accept File Edits" }],
};
const norm = normalizeAgent(listed, detail, new Map([["/home/u/proj", { canonical: "/canon/proj", error: null }]]));
assert.equal(norm.role, "peer");
assert.equal(norm.enforcement, "pack-enforced");
assert.equal(norm.status, "running", "status is lowercased across both shapes");
assert.equal(norm.parentAgentId, "lead-1");
assert.equal(norm.model, "claude-sonnet-5");
assert.equal(norm.inspectOk, true);
assert.equal(norm.canonicalCwd, "/canon/proj", "identity is the resolved path");
assert.equal(norm.cwd, "/home/u/proj", "the raw spelling survives for display");
assert.equal(norm.cwdError, null);
assert.equal(norm.modeLabel, "Accept File Edits", "the agent's own name for its mode");

// A cwd that will not resolve keeps the error and NEVER falls back to the raw
// string as an identity: null canonical means cannot-verify, not "elsewhere".
{
  const unresolvable = normalizeAgent(listed, detail, new Map([["/home/u/proj", { canonical: null, error: "ENOENT" }]]));
  assert.equal(unresolvable.canonicalCwd, null);
  assert.equal(unresolvable.cwdError, "ENOENT");
}
// No map at all (a caller that never canonicalized) is also cannot-verify.
assert.equal(normalizeAgent(listed, detail).canonicalCwd, null);
assert.match(normalizeAgent(listed, detail).cwdError, /never canonicalized/);

const uninspected = normalizeAgent(listed, null);
assert.equal(uninspected.inspectOk, false);
assert.equal(uninspected.parentAgentId, null, "no inspect means no parentage, never a guess");
assert.equal(uninspected.role, "peer", "role still comes from the list provider");
assert.equal(uninspected.modeLabel, null);
assert.ok(
  uninspected.cwd.endsWith(join("proj")) && !uninspected.cwd.startsWith("~"),
  "the `~/x` spelling ls returns is expanded before anything compares it",
);

// Staleness is suspected, never asserted, and only for inspected running agents.
assert.equal(markStale(norm, { now: Date.parse("2026-08-20T00:01:00.000Z") }).stale, false);
assert.equal(markStale(norm, { now: Date.parse("2026-08-20T00:30:00.000Z") }).stale, true);
assert.equal(markStale(uninspected, { now: Date.parse("2026-08-20T00:30:00.000Z") }).stale, false);
assert.equal(markStale({ ...norm, status: "idle" }, { now: Date.parse("2026-08-20T09:00:00.000Z") }).stale, false);

// ---------------------------------------------------------------------------
// Scoping is client-side: `paseo ls --json` has no server-side workspace scope.
// Canonical identity decides membership whenever both sides have one; the
// lexical compare survives only as the answer for paths nothing could resolve.
// ---------------------------------------------------------------------------

assert.equal(inScope({ cwd: "/a/b" }, { all: false, cwd: "/a/b" }), true);
assert.equal(inScope({ cwd: "/a/b" }, { all: false, cwd: "/a/c" }), false);
assert.equal(inScope({ cwd: "/a/c" }, { all: true, cwd: "/a/b" }), true);
assert.equal(inScope({ cwd: "/a/b/" }, { all: false, cwd: "/a/b" }), true, "trailing slash is the same workspace");

// Two spellings of one directory: identical canonical → in scope, even though
// the raw strings share nothing but their target.
assert.equal(
  inScope({ cwd: "~/proj", canonicalCwd: "/canon/proj" }, { all: false, cwd: "/link/proj", scopeCanonical: "/canon/proj" }),
  true,
  "canonical identity beats the spelling on both sides",
);
assert.equal(
  inScope({ cwd: "/canon/proj", canonicalCwd: "/canon/proj" }, { all: false, cwd: "/canon/other", scopeCanonical: "/canon/other" }),
  false,
);

// ---------------------------------------------------------------------------
// Graph shape.
// ---------------------------------------------------------------------------

const agents = [
  { id: "sup", shortId: "sup", role: "supervisor", provider: "claude-supervisor", status: "idle", cwd: "/w", canonicalCwd: "/w", pendingPermissions: [] },
  { id: "lead-1", shortId: "lead-1", role: "lead", provider: "claude-lead", status: "running", cwd: "/w", canonicalCwd: "/w", pendingPermissions: [] },
  { id: "peer-1", shortId: "peer-1", role: "peer", provider: "claude-peer", status: "running", cwd: "/w", canonicalCwd: "/w", parentAgentId: "lead-1", pendingPermissions: [] },
  { id: "peer-2", shortId: "peer-2", role: "peer", provider: "claude-peer", status: "waiting", cwd: "/w", canonicalCwd: "/w", parentAgentId: null, pendingPermissions: [] },
  { id: "rando", shortId: "rando", role: "unknown", provider: "claude", status: "idle", cwd: "/w", canonicalCwd: "/w", parentAgentId: "lead-1", pendingPermissions: [] },
];
const graph = buildGraph(agents, { daemon: { status: "running", version: "0.4.0" }, scope: "/w" });
const kinds = (kind) => graph.edges.filter((e) => e.data.kind === kind);
const nodeIds = new Set(graph.nodes.map((n) => n.id));

assert.ok(nodeIds.has("control-plane") && nodeIds.has("run-policy"), "declared bounds are nodes too");
assert.ok(nodeIds.has("workspace:/w"), "the workspace is the durable-truth node");
assert.equal(graph.meta.counts.leads, 1);
assert.equal(graph.meta.counts.peers, 2);
assert.equal(graph.meta.counts.unknown, 1);

assert.deepEqual(
  kinds("delegates").map((e) => `${e.source}->${e.target}`),
  ["lead-1->peer-1", "lead-1->rando"],
  "delegation edges come only from a real ParentAgentId that resolves in-scope",
);
assert.equal(
  kinds("delegates").filter((e) => e.target === "peer-2").length,
  0,
  "a peer with no parent must render unlinked, not attached to the nearest lead",
);
assert.ok(kinds("governs").some((e) => e.source === "sup" && e.target === "lead-1"));
assert.ok(kinds("bounds").every((e) => e.source === "run-policy"));
assert.equal(
  kinds("bounds").filter((e) => e.target === "rando").length,
  0,
  "an agent with no declared role is not claimed by the policy",
);
assert.equal(
  kinds("checkpoints").filter((e) => e.source === "rando").length,
  0,
  "unknown-role agents do not checkpoint into the governed workspace",
);

// One directory, three spellings, ONE durable-truth node. Before canonical
// ingest each spelling was its own workspace — and its own A1 scope key.
{
  const split = buildGraph(
    [
      { id: "p1", shortId: "p1", role: "peer", provider: "claude-peer", status: "running", cwd: "~/w", canonicalCwd: "/w", pendingPermissions: [] },
      { id: "p2", shortId: "p2", role: "peer", provider: "claude-peer", status: "running", cwd: "/w/", canonicalCwd: "/w", pendingPermissions: [] },
      { id: "p3", shortId: "p3", role: "peer", provider: "claude-peer", status: "running", cwd: "/link/w", canonicalCwd: "/w", pendingPermissions: [] },
    ],
    { daemon: { status: "running" }, scope: "/w" },
  );
  const workspaceNodes = split.nodes.filter((n) => n.id.startsWith("workspace:"));
  assert.equal(workspaceNodes.length, 1, "three spellings of one directory are one workspace");
  assert.equal(workspaceNodes[0].id, "workspace:/w");
  assert.equal(split.edges.filter((e) => e.data.kind === "checkpoints").length, 3);
}

// A path nothing could resolve keeps its own node and SAYS so, rather than
// being merged into a neighbour on a guess.
{
  const unresolved = buildGraph(
    [{ id: "p1", shortId: "p1", role: "peer", provider: "claude-peer", status: "running", cwd: "/gone", canonicalCwd: null, pendingPermissions: [] }],
    { daemon: { status: "running" }, scope: "/w" },
  );
  const node = unresolved.nodes.find((n) => n.id.startsWith("workspace:"));
  assert.equal(node.id, "workspace:unresolved:/gone");
  assert.match(node.data.detail, /could not be resolved/);
  assert.equal(node.data.canonical, null);
}

// A parent outside the current scope must not produce a dangling edge.
const scopedOut = buildGraph(
  [{ id: "peer-x", shortId: "px", role: "peer", provider: "claude-peer", status: "running", cwd: "/w", canonicalCwd: "/w", parentAgentId: "lead-elsewhere", pendingPermissions: [] }],
  { daemon: { status: "running" }, scope: "/w" },
);
assert.equal(scopedOut.edges.filter((e) => e.data.kind === "delegates").length, 0);

// Every edge must reference nodes that exist — React Flow silently drops the rest.
for (const edge of [...graph.edges, ...scopedOut.edges]) {
  assert.ok(nodeIds.has(edge.source) || scopedOut.nodes.some((n) => n.id === edge.source), `dangling source: ${edge.source}`);
}

// ---------------------------------------------------------------------------
// An unreachable daemon degrades to an empty, honest graph — never a throw.
// ---------------------------------------------------------------------------

const failed = await collectGraph({
  runPaseoJson: async () => { throw new Error("daemon down"); },
  maxAttempts: 1,
  cwd: "/w",
});
assert.equal(failed.meta.daemon.status, "unreachable");
assert.match(failed.error, /daemon down/);
assert.equal(failed.nodes.filter((n) => n.type === "agent").length, 0);

// ---------------------------------------------------------------------------
// Collection against a fake CLI: scoping, fan-out and partial marking.
// ---------------------------------------------------------------------------

const fakeList = [
  { id: "L", shortId: "L", provider: "claude-lead/opus", status: "running", cwd: "/w" },
  { id: "P", shortId: "P", provider: "claude-peer/sonnet", status: "running", cwd: "/w" },
  { id: "OTHER", shortId: "O", provider: "claude-peer/sonnet", status: "running", cwd: "/elsewhere" },
];
const collected = await collectGraph({
  cwd: "/w",
  runPaseoJson: async (args) => {
    if (args[0] === "ls") return fakeList;
    if (args[1] === "L") return { Id: "L", Provider: "claude-lead", Status: "running", Cwd: "/w" };
    if (args[1] === "P") return { Id: "P", Provider: "claude-peer", Status: "running", Cwd: "/w", ParentAgentId: "L" };
    throw new Error("inspect failed");
  },
  maxAttempts: 1,
});
assert.equal(collected.meta.counts.leads, 1);
assert.equal(collected.meta.counts.peers, 1);
assert.ok(
  !collected.nodes.some((n) => n.id === "OTHER"),
  "an agent in another workspace must not appear in a scoped graph",
);
assert.equal(collected.edges.filter((e) => e.data.kind === "delegates").length, 1);

const all = await collectGraph({
  all: true,
  runPaseoJson: async (args) =>
    args[0] === "ls"
      ? fakeList
      : { Id: args[1], Provider: args[1] === "L" ? "claude-lead" : "claude-peer", Status: "running" },
  maxAttempts: 1,
});
assert.equal(all.meta.counts.peers, 2, "--all opts into every workspace");

// A failed inspect marks the snapshot partial rather than pretending completeness.
const partial = await collectGraph({
  cwd: "/w",
  runPaseoJson: async (args) => {
    if (args[0] === "ls") return [{ id: "P", shortId: "P", provider: "claude-peer/x", status: "running", cwd: "/w" }];
    throw new Error("inspect failed");
  },
  maxAttempts: 1,
});
assert.equal(partial.meta.partial, true);

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

assert.equal(parseArgs(["--all"]).all, true);
assert.equal(parseArgs(["-g"]).all, true);
assert.equal(parseArgs(["--out", "g.json"]).out, "g.json");
assert.equal(parseArgs(["--serve"]).serve, 7788);
assert.equal(parseArgs(["--serve", "9000"]).serve, 9000);
assert.equal(parseArgs(["--serve", "--all"]).serve, 7788, "--serve without a port must not eat the next flag");
assert.equal(parseArgs(["--cwd", "/x"]).cwd, "/x");

// ---------------------------------------------------------------------------
// Snapshot cache: the inspect fan-out is expensive (~30s for 85 agents), so a
// polling viewer must never re-pay it, and concurrent requests must coalesce.
// ---------------------------------------------------------------------------

{
  const { createSnapshotCache } = await import("../scripts/governance-graph.mjs");
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const snapshot = createSnapshotCache({}, {
    ttlMs: 1000,
    collect: async () => { calls++; await gate; return { nodes: [], edges: [], meta: { calls } }; },
  });

  const [a, b, c] = [snapshot(), snapshot(), snapshot()];
  release();
  await Promise.all([a, b, c]);
  assert.equal(calls, 1, "concurrent requests must coalesce onto one collection");

  await snapshot(Date.now());
  assert.equal(calls, 1, "a fresh snapshot is reused inside the TTL");

  await snapshot(Date.now() + 5000);
  assert.equal(calls, 2, "an expired snapshot triggers exactly one new collection");
}

console.log("governance graph tests passed");
