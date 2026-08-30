// governance-graph-assert.test.mjs — topology invariants A1–A6 over built graphs.
// Run: node test/governance-graph-assert.test.mjs
//
// assertTopology is pure over the graph object, so every fixture here is
// constructed directly — no daemon, no CLI spawn except for the usage-error
// exit-code contract, which fails before any collection is attempted.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSERT_RULES,
  assertTopology,
  buildGraph,
  collectGraph,
  writePosture,
} from "../scripts/governance-graph.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "governance-graph.mjs");

const agent = (id, role, { mode = null, cwd = "/w", status = "running", parentAgentId = null } = {}) => ({
  id,
  shortId: id,
  name: id,
  role,
  provider: role === "unknown" ? "claude" : `claude-${role}`,
  status,
  mode,
  cwd,
  parentAgentId,
  pendingPermissions: [],
});

// Mark a fixture graph as an uncapped, fully inspected scan so A6 stays quiet
// while the other invariants are exercised in isolation.
const complete = (graph) => {
  const n = graph.meta.counts.tasks;
  graph.meta.scan = { listedTotal: n, scopedTotal: n, rendered: n, truncated: false, uninspected: 0 };
  graph.meta.partial = false;
  return graph;
};
const graphOf = (agents) => complete(buildGraph(agents, { daemon: { status: "running" }, scope: "/w" }));
const byRule = (entries, code) => entries.filter((e) => e.rule.startsWith(code));

// ---------------------------------------------------------------------------
// Write posture: only unambiguous modes classify; everything else is unknown,
// because an approval-gated agent may or may not write and guessing either
// way invents a signal.
// ---------------------------------------------------------------------------

assert.equal(writePosture("acceptEdits"), "write");
assert.equal(writePosture("bypassPermissions"), "write");
assert.equal(writePosture("yolo"), "write");
assert.equal(writePosture("plan"), "read-only");
assert.equal(writePosture("read-only"), "read-only");
assert.equal(writePosture("readOnly"), "read-only");
assert.equal(writePosture(null), "unknown", "no inspect data is unknown, never a pass");
assert.equal(writePosture(undefined), "unknown");
assert.equal(writePosture("default"), "unknown", "approval-gated mode must not be guessed either way");
assert.equal(writePosture("some-future-mode"), "unknown");

// Every rule entry carries the rule slug so a reader never has to decode A-codes.
assert.deepEqual(Object.keys(ASSERT_RULES), ["A1", "A2", "A3", "A4", "A5", "A6"]);

// ---------------------------------------------------------------------------
// A healthy topology is fully quiet — no violations AND nothing unverifiable.
// ---------------------------------------------------------------------------

{
  const g = graphOf([
    agent("sup", "supervisor", { mode: "plan" }),
    agent("lead-1", "lead", { mode: "plan" }),
    agent("peer-1", "peer", { mode: "acceptEdits", cwd: "/w", parentAgentId: "lead-1" }),
    agent("peer-2", "peer", { mode: "acceptEdits", cwd: "/w2", parentAgentId: "lead-1" }),
  ]);
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, [], `clean graph must not violate: ${JSON.stringify(violations)}`);
  assert.deepEqual(cannotVerify, [], `clean graph must be fully verifiable: ${JSON.stringify(cannotVerify)}`);
}

// ---------------------------------------------------------------------------
// A1 — one writer per scope.
// ---------------------------------------------------------------------------

{
  const g = graphOf([
    agent("peer-1", "peer", { mode: "acceptEdits" }),
    agent("peer-2", "peer", { mode: "acceptEdits" }),
  ]);
  const { violations, cannotVerify } = assertTopology(g);
  const a1 = byRule(violations, "A1");
  assert.equal(a1.length, 1);
  assert.equal(a1[0].rule, "A1-one-writer-per-scope");
  assert.deepEqual(a1[0].agents, ["peer-1", "peer-2"]);
  assert.match(a1[0].evidence, /2 write-capable peers share scope \/w/);
  assert.deepEqual(byRule(cannotVerify, "A1"), []);
}

// One writer plus a read-only peer in the same scope is the intended shape.
{
  const res = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "acceptEdits" }),
    agent("peer-2", "peer", { mode: "plan" }),
  ]));
  assert.deepEqual(res.violations, []);
  assert.deepEqual(res.cannotVerify, []);
}

// A peer whose posture is invisible next to a confirmed writer: not a
// violation (that would invent a signal) and not a pass (unknown never is) —
// it is cannot_verify with the concrete reason.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "acceptEdits" }),
    agent("peer-2", "peer", { mode: null }),
  ]));
  assert.deepEqual(byRule(violations, "A1"), []);
  const cv = byRule(cannotVerify, "A1");
  assert.equal(cv.length, 1);
  assert.deepEqual(cv[0].agents, ["peer-2"]);
  assert.match(cv[0].evidence, /mode absent \(no inspect data\)/);
  assert.match(cv[0].evidence, /second writer cannot be ruled out/);
}

// An unrecognized mode string is just as unverifiable as a missing one.
{
  const { cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "acceptEdits" }),
    agent("peer-2", "peer", { mode: "default" }),
  ]));
  assert.match(byRule(cannotVerify, "A1")[0].evidence, /unrecognized mode "default"/);
}

// A peer with no cwd signal cannot be placed in any scope.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "acceptEdits", cwd: "" }),
    agent("peer-2", "peer", { mode: "acceptEdits" }),
  ]));
  assert.deepEqual(byRule(violations, "A1"), []);
  const cv = byRule(cannotVerify, "A1");
  assert.equal(cv.length, 1);
  assert.deepEqual(cv[0].agents, ["peer-1"]);
  assert.match(cv[0].evidence, /no cwd signal/);
}

// ---------------------------------------------------------------------------
// A2 — writer-is-acceptor: a lead in a write-capable posture.
// ---------------------------------------------------------------------------

{
  const { violations } = assertTopology(graphOf([agent("lead-1", "lead", { mode: "acceptEdits" })]));
  const a2 = byRule(violations, "A2");
  assert.equal(a2.length, 1);
  assert.deepEqual(a2[0].agents, ["lead-1"]);
  assert.match(a2[0].evidence, /write-capable mode "acceptEdits"/);
  assert.match(a2[0].evidence, /leadWrite policy:/);
}

{
  const { violations, cannotVerify } = assertTopology(graphOf([agent("lead-1", "lead", { mode: null })]));
  assert.deepEqual(byRule(violations, "A2"), []);
  const cv = byRule(cannotVerify, "A2");
  assert.equal(cv.length, 1);
  assert.match(cv[0].evidence, /read-only cannot be confirmed/);
}

// ---------------------------------------------------------------------------
// A3 — unknown role inside a governed scope.
// ---------------------------------------------------------------------------

{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("rando", "unknown", {}),
  ]));
  const a3 = byRule(violations, "A3");
  assert.equal(a3.length, 1);
  assert.deepEqual(a3[0].agents, ["rando"]);
  assert.match(a3[0].evidence, /governed scope \/w/);
  assert.match(a3[0].evidence, /lead-1/);
  assert.deepEqual(byRule(cannotVerify, "A3"), []);
}

// An unknown-role agent in its own, ungoverned cwd is someone else's business.
{
  const { violations } = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("rando", "unknown", { cwd: "/elsewhere" }),
  ]));
  assert.deepEqual(byRule(violations, "A3"), []);
}

// No cwd signal → no way to place it inside or outside governance.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("rando", "unknown", { cwd: "" }),
  ]));
  assert.deepEqual(byRule(violations, "A3"), []);
  const cv = byRule(cannotVerify, "A3");
  assert.equal(cv.length, 1);
  assert.match(cv[0].evidence, /cannot be determined/);
}

// ---------------------------------------------------------------------------
// A4 — a peer that parents delegation edges.
// ---------------------------------------------------------------------------

{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("peer-boss", "peer", { mode: "plan" }),
    agent("peer-kid", "peer", { mode: "plan", parentAgentId: "peer-boss" }),
  ]));
  const a4 = byRule(violations, "A4");
  assert.equal(a4.length, 1);
  assert.deepEqual(a4[0].agents, ["peer-boss", "peer-kid"]);
  assert.match(a4[0].evidence, /never orchestrates/);
  assert.deepEqual(byRule(cannotVerify, "A4"), []);
}

// A lead parenting peers is the intended shape — covered by the clean graph
// above. A partial snapshot, however, means absent edges prove nothing.
{
  const g = graphOf([agent("peer-1", "peer", { mode: "plan" })]);
  g.meta.scan = { listedTotal: 2, scopedTotal: 2, rendered: 1, truncated: true, uninspected: 0 };
  g.meta.partial = true;
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(byRule(violations, "A4"), []);
  const cv = byRule(cannotVerify, "A4");
  assert.equal(cv.length, 1);
  assert.match(cv[0].evidence, /not proof that no peer orchestrates/);
  assert.deepEqual(byRule(violations, "A6"), [], "an explicitly signaled cap is honest, not an A6 violation");
}

// ---------------------------------------------------------------------------
// A5 — supervisor must stay observe-only.
// ---------------------------------------------------------------------------

{
  const { violations } = assertTopology(graphOf([
    agent("sup", "supervisor", { mode: "plan" }),
    agent("peer-1", "peer", { mode: "plan", parentAgentId: "sup" }),
  ]));
  const a5 = byRule(violations, "A5");
  assert.equal(a5.length, 1);
  assert.deepEqual(a5[0].agents, ["peer-1", "sup"]);
  assert.match(a5[0].evidence, /observe-only and never orchestrates/);
}

{
  const a5 = byRule(assertTopology(graphOf([agent("sup", "supervisor", { mode: "acceptEdits" })])).violations, "A5");
  assert.equal(a5.length, 1);
  assert.match(a5[0].evidence, /write-capable mode "acceptEdits"/);
}

{
  const { violations, cannotVerify } = assertTopology(graphOf([agent("sup", "supervisor", { mode: null })]));
  assert.deepEqual(byRule(violations, "A5"), []);
  const cv = byRule(cannotVerify, "A5");
  assert.equal(cv.length, 1);
  assert.match(cv[0].evidence, /observe-only cannot be confirmed/);
}

// ---------------------------------------------------------------------------
// A6 — count integrity: a capped scan presented as a total IS the violation.
// ---------------------------------------------------------------------------

// Rendered fewer than scoped with no truncation flag: the silent-cap defect.
{
  const g = graphOf([agent("peer-1", "peer", { mode: "plan" })]);
  g.meta.scan = { listedTotal: 10, scopedTotal: 10, rendered: 1, truncated: false, uninspected: 0 };
  g.meta.partial = false;
  const a6 = byRule(assertTopology(g).violations, "A6");
  assert.equal(a6.length, 1);
  assert.match(a6[0].evidence, /rendered 1 of 10/);
  assert.match(a6[0].evidence, /must never read as a total/);
}

// Truncation admitted in scan but contradicted by the summary flag.
{
  const g = graphOf([agent("peer-1", "peer", { mode: "plan" })]);
  g.meta.scan = { listedTotal: 10, scopedTotal: 10, rendered: 1, truncated: true, uninspected: 0 };
  g.meta.partial = false;
  const a6 = byRule(assertTopology(g).violations, "A6");
  assert.equal(a6.length, 1);
  assert.match(a6[0].evidence, /meta\.partial is not true/);
}

// Failed inspects are incompleteness too, and must be surfaced.
{
  const g = graphOf([agent("peer-1", "peer", { mode: "plan" })]);
  g.meta.scan = { listedTotal: 1, scopedTotal: 1, rendered: 1, truncated: false, uninspected: 1 };
  g.meta.partial = false;
  assert.equal(byRule(assertTopology(g).violations, "A6").length, 1);
}

// Counts claiming a population other than the rendered set.
{
  const g = graphOf([agent("peer-1", "peer", { mode: "plan" })]);
  g.meta.counts.tasks = 42;
  const a6 = byRule(assertTopology(g).violations, "A6");
  assert.equal(a6.length, 1);
  assert.match(a6[0].evidence, /counts\.tasks=42/);
}

// No scan metadata at all → not a pass and not an invented violation.
{
  const g = buildGraph([agent("peer-1", "peer", { mode: "plan" })], { daemon: {}, scope: "/w" });
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(byRule(violations, "A6"), []);
  const cv = byRule(cannotVerify, "A6");
  assert.equal(cv.length, 1);
  assert.match(cv[0].evidence, /meta\.scan is absent or malformed/);
}

// Pure and total over degenerate inputs — never a throw.
{
  const res = assertTopology({ nodes: [], edges: [], meta: {} });
  assert.deepEqual(res.violations, []);
  assert.equal(byRule(res.cannotVerify, "A6").length, 1);
  assert.deepEqual(assertTopology({}).violations, []);
  assert.deepEqual(assertTopology(undefined).violations, []);
}

// ---------------------------------------------------------------------------
// The A6 fix in collectGraph: the maxAgents cap used to surface only as a lone
// boolean while counts read as totals. meta.scan now carries the pre-cap
// population explicitly, and an explicitly signaled cap passes A6.
// ---------------------------------------------------------------------------

{
  const fakeList = [
    { id: "L", shortId: "L", provider: "claude-lead/opus", status: "running", cwd: "/w" },
    { id: "P1", shortId: "P1", provider: "claude-peer/s", status: "running", cwd: "/w" },
    { id: "P2", shortId: "P2", provider: "claude-peer/s", status: "running", cwd: "/w" },
  ];
  const g = await collectGraph({
    cwd: "/w",
    maxAgents: 2,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") return fakeList;
      if (args[0] === "status") return {};
      return { Id: args[1], Provider: args[1] === "L" ? "claude-lead" : "claude-peer", Status: "running", Cwd: "/w", Mode: "plan" };
    },
  });
  assert.deepEqual(g.meta.scan, { listedTotal: 3, scopedTotal: 3, rendered: 2, truncated: true, uninspected: 0 });
  assert.equal(g.meta.partial, true);
  assert.equal(g.meta.counts.tasks, 2, "counts describe the rendered set, not a pretended total");
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(byRule(violations, "A6"), [], "explicit truncation signaling satisfies A6");
  assert.equal(byRule(cannotVerify, "A4").length, 1, "a partial snapshot notes its delegation blindness");
}

// An uncapped, fully inspected collection asserts clean end to end.
{
  const g = await collectGraph({
    cwd: "/w",
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") return [{ id: "P1", shortId: "P1", provider: "claude-peer/s", status: "running", cwd: "/w" }];
      if (args[0] === "status") return {};
      return { Id: "P1", Provider: "claude-peer", Status: "running", Cwd: "/w", Mode: "acceptEdits" };
    },
  });
  assert.equal(g.meta.partial, false);
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, []);
  assert.deepEqual(cannotVerify, []);
}

// ---------------------------------------------------------------------------
// Exit-code contract, usage errors only — these fail in parseArgs, before any
// collection, so no daemon is touched.
// ---------------------------------------------------------------------------

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });
}

for (const [args, label] of [
  [["--bogus"], "unknown flag"],
  [["--assert", "--serve"], "assert cannot combine with serve"],
  [["--cwd"], "missing --cwd value"],
  [["--assert", "--out", "--all"], "flag eaten as --out value"],
]) {
  const result = runCli(args);
  assert.equal(result.status, 2, `${label}: ${result.stdout} ${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false, label);
  assert.equal(envelope.code, "USAGE", label);
  assert.ok(envelope.message.length > 0, label);
}

// --help exits 0, documents --assert and its exit codes, and touches no daemon.
{
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--assert/);
  assert.match(result.stdout, /3 {2}violations found/);
  assert.match(result.stdout, /cannotVerify/);
}

console.log("governance-graph-assert tests passed");
