// governance-graph-assert.test.mjs — topology invariants A1–A6 over built graphs.
// Run: node test/governance-graph-assert.test.mjs
//
// assertTopology is pure over the graph object — it resolves no paths and
// spawns nothing — so most fixtures here are constructed directly. Three
// exceptions go through the real machinery on purpose, because they are the
// tests that would let the pack-ship defects back in if they were faked:
//   - the two-spelling + symlink fixture runs collectGraph against real dirs;
//   - the empty-scope control drives the CLI through PASEO_TEAM_PASEO_EXEC to
//     a real exit 3;
//   - the mode table is checked against AvailableModes MEASURED from the
//     daemon, not against the table's own opinion of itself.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSERT_RULES,
  MODE_POSTURES,
  assertTopology,
  buildGraph,
  collectGraph,
  providerFamily,
  writePosture,
} from "../scripts/governance-graph.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "governance-graph.mjs");
const isWindows = process.platform === "win32";
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// `canonicalCwd` defaults to the raw cwd: assertTopology never resolves paths
// itself, so a fixture that omits it would be testing the unresolved branch by
// accident. Provider defaults to the pack's own claude-* seats — which are
// pack-enforced, and therefore the case where Mode means nothing.
const agent = (id, role, {
  mode = null,
  cwd = "/w",
  canonicalCwd = undefined,
  status = "running",
  parentAgentId = null,
  provider = role === "unknown" ? "claude" : `claude-${role}`,
  modeLabel = null,
} = {}) => ({
  id,
  shortId: id,
  name: id,
  role,
  provider,
  status,
  mode,
  modeLabel,
  cwd,
  canonicalCwd: canonicalCwd === undefined ? (cwd || null) : canonicalCwd,
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
const advisories = (entries) => entries.filter((e) => e.advisory === true);

// ---------------------------------------------------------------------------
// Write posture is a property of (provider family, mode id).
//
// The collision that broke the flat table: omp's "write" is an ask-first gate
// while claude's "acceptEdits" is a standing grant. One token table read the
// first as a confirmed writer and missed codex's "full-access" entirely.
// ---------------------------------------------------------------------------

assert.equal(writePosture("claude-peer", "acceptEdits"), "write");
assert.equal(writePosture("claude-lead", "bypassPermissions"), "write");
assert.equal(writePosture("claude-peer", "plan"), "read-only");
assert.equal(writePosture("claude-peer", "default"), "approval-gated");
assert.equal(writePosture("claude-peer", "auto"), "unknown", "measured, deliberately unclassified");

assert.equal(writePosture("omp/google-antigravity/gemini-3.7-flash", "write"), "approval-gated",
  "omp 'write' is Write Approval — reading it as a writer is how A1 invented violations");
assert.equal(writePosture("omp", "full"), "write");
assert.equal(writePosture("codex", "full-access"), "write", "the real codex writer the flat table missed");
assert.equal(writePosture("codex", "auto"), "approval-gated");
assert.equal(writePosture("agy", "dangerously-skip-permissions"), "write");
assert.equal(writePosture("agy", "plan"), "read-only");

assert.equal(writePosture("claude-peer", null), "unknown", "no inspect data is unknown, never a pass");
assert.equal(writePosture("claude-peer", undefined), "unknown");
assert.equal(writePosture("claude-peer", ""), "unknown");
assert.equal(writePosture("claude-peer", "some-future-mode"), "unknown");
assert.equal(writePosture("grok", "default"), "unknown", "a provider with no measured table classifies nothing");
assert.equal(writePosture("", "acceptEdits"), "unknown");
// Exact ids only. The old lowercase-and-strip-separators pass is precisely
// what let "write" and "accept-edits" collide across providers.
assert.equal(writePosture("claude-peer", "acceptedits"), "unknown");
assert.equal(writePosture("claude-peer", "accept-edits"), "unknown");

// KILLING TEST — mode-table completeness against MEASURED daemon output.
// `paseo inspect <id> --json` → .AvailableModes, captured 2026-08-31 from a
// live seat of each family on the pack's own host. A provider that ships a new
// mode, or a family added to the fleet without a classification, fails here
// instead of silently degrading every posture check to "unknown".
const MEASURED_AVAILABLE_MODES = Object.freeze({
  "claude-peer": ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
  claude: ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
  "omp/google-antigravity/gemini-3.1-pro": ["full", "write", "ask"],
  codex: ["auto", "auto-review", "full-access"],
});
for (const [provider, modes] of Object.entries(MEASURED_AVAILABLE_MODES)) {
  for (const mode of modes) {
    // Family via the exported providerFamily(): a private copy here would pin
    // the table against itself and let the real derivation regress unseen.
    assert.ok(
      Object.prototype.hasOwnProperty.call(MODE_POSTURES[providerFamily(provider)] ?? {}, mode),
      `${provider} publishes mode "${mode}" but the posture table does not classify it`,
    );
  }
}
// agy publishes an EMPTY AvailableModes (measured), so its row is classified
// from documentation instead — the four ACP modes docs/review-instruments.md
// records. Pinned so a later reader knows which rows rest on which evidence.
assert.deepEqual(Object.keys(MODE_POSTURES.agy).sort(),
  ["accept-edits", "dangerously-skip-permissions", "default", "plan"]);

// Every rule entry carries the rule slug so a reader never has to decode A-codes.
assert.deepEqual(Object.keys(ASSERT_RULES), ["A1", "A2", "A3", "A4", "A5", "A6"]);

// ---------------------------------------------------------------------------
// A healthy topology is fully quiet — no violations AND nothing unverifiable.
// Unenforced read-only seats are the only shape that can be fully verified:
// where a mode is the whole story, a read-only mode ends the question.
// ---------------------------------------------------------------------------

{
  const g = graphOf([
    agent("sup", "supervisor", { mode: "plan", provider: "agy-supervisor" }),
    agent("lead-1", "lead", { mode: "plan", provider: "agy-lead" }),
    agent("peer-1", "peer", { mode: "plan", provider: "agy-peer", cwd: "/w", parentAgentId: "lead-1" }),
    agent("peer-2", "peer", { mode: "plan", provider: "agy-peer", cwd: "/w2", parentAgentId: "lead-1" }),
  ]);
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, [], `clean graph must not violate: ${JSON.stringify(violations)}`);
  assert.deepEqual(cannotVerify, [], `clean graph must be fully verifiable: ${JSON.stringify(cannotVerify)}`);
}

// The pack's OWN fleet is the other healthy shape, and it is not silent: a
// pack-enforced seat's mode says nothing, so each scope reports that blindness
// once. Quiet would be a lie; a line per agent would be a flood.
{
  const g = graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("peer-1", "peer", { mode: "bypassPermissions", parentAgentId: "lead-1" }),
    agent("peer-2", "peer", { mode: "bypassPermissions", parentAgentId: "lead-1" }),
  ]);
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, [], "two pack-enforced peers are not a dual-writer fact");
  const a1 = byRule(cannotVerify, "A1");
  assert.equal(a1.length, 1, "one line for the scope, not one per seat");
  assert.deepEqual(a1[0].agents, ["peer-1", "peer-2"]);
  assert.match(a1[0].evidence, /PreToolUse hook decides write authority/);
  assert.match(a1[0].evidence, /Mode is not evidence here/);
}

// ---------------------------------------------------------------------------
// A1 — one writer per scope.
//
// KILLING TEST (SYNTHETIC POSITIVE CONTROL — read the comment before "fixing"
// it): the branch needs a seat that is BOTH role=peer and unenforced. No
// shipped provider is both, because role is read off the suffix that only the
// pack-enforced claude-* providers carry. `omp-peer` is hand-built here so the
// specification A1 will be held to the day F015 lands is executable today.
// ---------------------------------------------------------------------------

{
  const g = graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer" }),
    agent("peer-2", "peer", { mode: "full", provider: "omp-peer" }),
  ]);
  const { violations, cannotVerify } = assertTopology(g);
  const a1 = byRule(violations, "A1");
  assert.equal(a1.length, 1);
  assert.equal(a1[0].rule, "A1-one-writer-per-scope");
  assert.deepEqual(a1[0].agents, ["peer-1", "peer-2"]);
  assert.match(a1[0].evidence, /2 running write-capable peers share scope \/w/);
  assert.deepEqual(byRule(cannotVerify, "A1"), []);
}

// Liveness is a precondition, not a decoration: the same pair, one of them
// finished, is the daily correction flow — a new writer taking over a scope
// whose previous writer is done — and it must not trip the gate.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer" }),
    agent("peer-2", "peer", { mode: "full", provider: "omp-peer", status: "idle" }),
  ]));
  assert.deepEqual(byRule(violations, "A1"), []);
  assert.equal(advisories(cannotVerify).length, 1, "the idle seat is one advisory, not a violation");
}

// KILLING TEST — the M4 fixture, measured on this repo: 1 running + 11 idle
// claude-peer seats in one scope, every one of them in a write-capable mode.
// Before the fix this was 12 write-capable peers and one exit-3 violation every
// morning. After it: zero violations, and the idle population collapses to ONE
// advisory line that names the tool which actually owns the retire decision.
{
  const fleet = [agent("peer-live", "peer", { mode: "bypassPermissions" })];
  for (let i = 0; i < 11; i++) {
    fleet.push(agent(`peer-idle-${i}`, "peer", { mode: "bypassPermissions", status: "idle" }));
  }
  const { violations, cannotVerify } = assertTopology(graphOf(fleet));
  assert.deepEqual(violations, [], "idle seats are not evidence that anything is mutating");
  const advisory = advisories(cannotVerify);
  assert.equal(advisory.length, 1, `M4 fixture must produce exactly one advisory: ${JSON.stringify(advisory)}`);
  assert.equal(advisory[0].agents.length, 11, "all eleven are named in the one line");
  assert.match(advisory[0].evidence, /11 non-running peer\(s\)/);
  assert.match(advisory[0].evidence, /reconcile-observer\.mjs/, "the advisory names the owner of the question");
  assert.match(advisory[0].evidence, /Idle is not evidence/);
}

// One writer plus a read-only peer in the same scope is the intended shape.
// (agy publishes `plan`; omp does not — a mode is only read against the table
// of the provider that actually offers it.)
{
  const res = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer" }),
    agent("peer-2", "peer", { mode: "plan", provider: "agy-peer" }),
  ]));
  assert.deepEqual(res.violations, []);
  assert.deepEqual(res.cannotVerify, []);
}

// A running unenforced peer whose posture is invisible next to a confirmed
// writer: not a violation (that would invent a signal) and not a pass (unknown
// never is) — cannot_verify with the concrete reason.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer" }),
    agent("peer-2", "peer", { mode: null, provider: "omp-peer" }),
  ]));
  assert.deepEqual(byRule(violations, "A1"), []);
  const cv = byRule(cannotVerify, "A1");
  assert.equal(cv.length, 1);
  assert.deepEqual(cv[0].agents, ["peer-2"]);
  assert.match(cv[0].evidence, /mode absent \(no inspect data\)/);
  assert.match(cv[0].evidence, /second writer cannot be ruled out/);
}

// An approval-gated mode is CLASSIFIED and still cannot rule a writer out —
// and the evidence line says which of the two it is, in the agent's own words.
{
  const { cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer" }),
    agent("peer-2", "peer", { mode: "write", provider: "omp-peer", modeLabel: "Write Approval" }),
  ]));
  const cv = byRule(cannotVerify, "A1");
  assert.match(cv[0].evidence, /approval-gated mode "write" \(omp-peer calls it "Write Approval"\)/);
}

// A mode no table classifies is reported with the agent's own label for it.
{
  const { cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer" }),
    agent("peer-2", "peer", { mode: "warp-drive", provider: "omp-peer", modeLabel: "Warp Drive" }),
  ]));
  assert.match(byRule(cannotVerify, "A1")[0].evidence, /"warp-drive" \(omp-peer calls it "Warp Drive"\) is not in the omp posture table/);
}

// A seat on a provider this pack neither enforces nor documents: unknown
// enforcement is its own line, because "is Mode authority here?" is unanswered.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "acceptEdits", provider: "pi-peer" }),
    agent("peer-2", "peer", { mode: "acceptEdits", provider: "pi-peer" }),
  ]));
  assert.deepEqual(byRule(violations, "A1"), []);
  const cv = byRule(cannotVerify, "A1");
  assert.equal(cv.length, 1);
  assert.match(cv[0].evidence, /neither enforces nor documents as unenforced/);
}

// A peer with no cwd signal cannot be placed in any scope.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer", cwd: "" }),
    agent("peer-2", "peer", { mode: "full", provider: "omp-peer" }),
  ]));
  assert.deepEqual(byRule(violations, "A1"), []);
  const cv = byRule(cannotVerify, "A1");
  assert.equal(cv.length, 1);
  assert.deepEqual(cv[0].agents, ["peer-1"]);
  assert.match(cv[0].evidence, /no cwd signal/);
}

// A cwd that would not resolve is never keyed as a scope of its own: it is
// reported with the resolve error, and it does not pair with anybody.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer", cwd: "/gone", canonicalCwd: null }),
    agent("peer-2", "peer", { mode: "full", provider: "omp-peer", cwd: "/gone", canonicalCwd: null }),
  ]));
  assert.deepEqual(byRule(violations, "A1"), [], "two unresolved paths are not a proven shared scope");
  const cv = byRule(cannotVerify, "A1");
  assert.equal(cv.length, 1);
  assert.deepEqual(cv[0].agents, ["peer-1", "peer-2"]);
  assert.match(cv[0].evidence, /could not be canonicalized/);
  assert.match(cv[0].evidence, /never read as "not in this scope"/);
}

// ---------------------------------------------------------------------------
// A2 — writer-is-acceptor, DEMOTED TO ADVISORY until F015. "Lead" is a
// provider-name suffix; a morning gate must not exit 3 on a naming convention.
// ---------------------------------------------------------------------------

{
  const { violations, cannotVerify } = assertTopology(graphOf([agent("lead-1", "lead", { mode: "acceptEdits" })]));
  assert.deepEqual(byRule(violations, "A2"), [], "A2 is advisory until F015 gives roles a source");
  const a2 = byRule(cannotVerify, "A2");
  assert.equal(a2.length, 1);
  assert.equal(a2[0].advisory, true);
  assert.deepEqual(a2[0].agents, ["lead-1"]);
  assert.match(a2[0].evidence, /write-capable mode "acceptEdits"/);
  assert.match(a2[0].evidence, /pack-enforced, so the mode is not its authority/);
  assert.match(a2[0].evidence, /THIS collector's environment/, "leadWrite is collector-local and says so");
}

{
  const { violations, cannotVerify } = assertTopology(graphOf([agent("lead-1", "lead", { mode: null })]));
  assert.deepEqual(byRule(violations, "A2"), []);
  const cv = byRule(cannotVerify, "A2");
  assert.equal(cv.length, 1);
  assert.equal(cv[0].advisory, undefined, "blindness is not an advisory; they are different admissions");
  assert.match(cv[0].evidence, /read-only cannot be confirmed/);
}

// ---------------------------------------------------------------------------
// A3 — unknown role inside a governed scope, DEMOTED TO ADVISORY until F015:
// the documented scout fleet runs on providers whose names cannot carry a role.
// ---------------------------------------------------------------------------

{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("rando", "unknown", {}),
  ]));
  assert.deepEqual(byRule(violations, "A3"), []);
  const a3 = byRule(cannotVerify, "A3");
  assert.equal(a3.length, 1);
  assert.equal(a3[0].advisory, true);
  assert.deepEqual(a3[0].agents, ["rando"]);
  assert.match(a3[0].evidence, /governed scope \/w/);
  assert.match(a3[0].evidence, /lead-1/);
  assert.match(a3[0].evidence, /looks identical to an ungoverned stray until F015/);
}

// An unknown-role agent in its own, ungoverned cwd is someone else's business.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("rando", "unknown", { cwd: "/elsewhere" }),
  ]));
  assert.deepEqual(byRule(violations, "A3"), []);
  assert.deepEqual(byRule(cannotVerify, "A3"), []);
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
// A4 — a peer that parents delegation edges. Edges come only from a real
// ParentAgentId, so a hit here is a fact and STAYS exit 3.
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
// A5 — split by evidence class: the delegation leg is a recorded fact and
// stays exit 3; the posture leg rests on the same role vocabulary as A2 and is
// demoted with it.
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
  const { violations, cannotVerify } = assertTopology(graphOf([agent("sup", "supervisor", { mode: "acceptEdits" })]));
  assert.deepEqual(byRule(violations, "A5"), [], "the posture leg is advisory; the delegation leg is not");
  const a5 = byRule(cannotVerify, "A5");
  assert.equal(a5.length, 1);
  assert.equal(a5[0].advisory, true);
  assert.match(a5[0].evidence, /write-capable mode "acceptEdits"/);
  assert.match(a5[0].evidence, /the hook — not the mode — is what actually denies/);
}

{
  const { violations, cannotVerify } = assertTopology(graphOf([agent("sup", "supervisor", { mode: null })]));
  assert.deepEqual(byRule(violations, "A5"), []);
  const cv = byRule(cannotVerify, "A5");
  assert.equal(cv.length, 1);
  assert.match(cv[0].evidence, /observe-only cannot be confirmed/);
}

// ---------------------------------------------------------------------------
// A6 — count integrity: a capped, partial, or EMPTY scan presented as a total
// IS the violation.
// ---------------------------------------------------------------------------

// KILLING TEST — a scan of nothing must never read as a pass. The daemon
// listed agents and the scope matched none of them: mistyped --cwd, stale
// spelling, or an idle workspace. Exit 0 said "clean" for all three.
{
  const g = buildGraph([], { daemon: { status: "running" }, scope: "/w" });
  g.meta.scan = { listedTotal: 12, scopedTotal: 0, rendered: 0, truncated: false, uninspected: 0 };
  g.meta.partial = false;
  const { violations } = assertTopology(g);
  const a6 = byRule(violations, "A6");
  assert.equal(a6.length, 1);
  assert.match(a6[0].evidence, /matched 0 of 12 listed agents/);
  assert.match(a6[0].evidence, /an empty scan is not a clean topology/);
}

// An empty DAEMON is a different statement: nothing to be wrong about, and
// still not a pass.
{
  const g = buildGraph([], { daemon: { status: "running" }, scope: "/w" });
  g.meta.scan = { listedTotal: 0, scopedTotal: 0, rendered: 0, truncated: false, uninspected: 0 };
  g.meta.partial = false;
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(byRule(violations, "A6"), [], "an empty daemon is not the scope's fault");
  assert.match(byRule(cannotVerify, "A6")[0].evidence, /not a verified-clean topology/);
}

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
// KILLING TEST — two spellings and a symlink, through collectGraph, on real
// directories. `ls` reports one spelling and `inspect` another for the same
// physical directory on every run of this tool; a third arrives through a
// symlinked worktree. Lexically that is three scopes and zero dual writers.
// ---------------------------------------------------------------------------

{
  const base = realpathSync(tmp("gg-scope-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const link = join(base, "link");
  let linked = true;
  try {
    symlinkSync(repo, link, "dir");
  } catch (error) {
    if (!isWindows) throw error; // Windows without developer mode cannot symlink
    linked = false;
  }

  // Same directory, three ways: trailing slash, symlink alias, plain.
  const fakeList = [
    { id: "P1", shortId: "P1", provider: "omp-peer/gemini", status: "running", cwd: `${repo}/` },
    { id: "P2", shortId: "P2", provider: "omp-peer/gemini", status: "running", cwd: linked ? link : repo },
  ];
  const g = await collectGraph({
    cwd: repo,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") return fakeList;
      if (args[0] === "status") return {};
      return {
        Id: args[1],
        Provider: "omp-peer",
        Status: "running",
        // inspect answers with its own spelling — the M1 split, reproduced.
        Cwd: args[1] === "P1" ? repo : `${linked ? link : repo}/`,
        Mode: "full",
        AvailableModes: [{ id: "full", label: "Full Access" }],
      };
    },
  });

  const workspaceNodes = g.nodes.filter((n) => n.id.startsWith("workspace:"));
  assert.equal(workspaceNodes.length, 1, `one physical directory is one scope: ${JSON.stringify(workspaceNodes.map((n) => n.id))}`);
  assert.equal(workspaceNodes[0].id, `workspace:${repo}`);
  assert.equal(g.meta.scan.scopedTotal, 2, "the symlinked spelling is still in scope");

  const { violations } = assertTopology(g);
  const a1 = byRule(violations, "A1");
  assert.equal(a1.length, 1, `dual writers on one directory must be one violation: ${JSON.stringify(violations)}`);
  assert.deepEqual(a1[0].agents, ["P1", "P2"]);
  assert.match(a1[0].evidence, /2 running write-capable peers share scope/);
}

// ---------------------------------------------------------------------------
// The A6 fix in collectGraph: the maxAgents cap used to surface only as a lone
// boolean while counts read as totals. meta.scan now carries the pre-cap
// population explicitly, and an explicitly signaled cap passes A6.
// ---------------------------------------------------------------------------

{
  const dir = realpathSync(tmp("gg-cap-"));
  const fakeList = [
    { id: "L", shortId: "L", provider: "claude-lead/opus", status: "running", cwd: dir },
    { id: "P1", shortId: "P1", provider: "claude-peer/s", status: "running", cwd: dir },
    { id: "P2", shortId: "P2", provider: "claude-peer/s", status: "running", cwd: dir },
  ];
  const g = await collectGraph({
    cwd: dir,
    maxAgents: 2,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") return fakeList;
      if (args[0] === "status") return {};
      return { Id: args[1], Provider: args[1] === "L" ? "claude-lead" : "claude-peer", Status: "running", Cwd: dir, Mode: "plan" };
    },
  });
  assert.deepEqual(g.meta.scan, {
    listedTotal: 3, scopedTotal: 3, rendered: 2, truncated: true, uninspected: 0, cwdUnresolved: 0,
  });
  assert.equal(g.meta.partial, true);
  assert.equal(g.meta.counts.tasks, 2, "counts describe the rendered set, not a pretended total");
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(byRule(violations, "A6"), [], "explicit truncation signaling satisfies A6");
  assert.equal(byRule(cannotVerify, "A4").length, 1, "a partial snapshot notes its delegation blindness");
}

// An uncapped, fully inspected collection over an unenforced read-only seat
// asserts clean end to end.
{
  const dir = realpathSync(tmp("gg-clean-"));
  const g = await collectGraph({
    cwd: dir,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") return [{ id: "P1", shortId: "P1", provider: "agy-peer/x", status: "running", cwd: dir }];
      if (args[0] === "status") return {};
      return { Id: "P1", Provider: "agy-peer", Status: "running", Cwd: dir, Mode: "plan" };
    },
  });
  assert.equal(g.meta.partial, false);
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, []);
  assert.deepEqual(cannotVerify, []);
}

// A cwd that will not resolve is scoped on its raw spelling and PUBLISHED as
// such — the one thing it may never do is disappear.
{
  const dir = realpathSync(tmp("gg-unresolved-"));
  const g = await collectGraph({
    cwd: dir,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") {
        return [
          { id: "P1", shortId: "P1", provider: "claude-peer/s", status: "running", cwd: dir },
          { id: "GONE", shortId: "GONE", provider: "claude-peer/s", status: "running", cwd: join(dir, "deleted-worktree") },
        ];
      }
      if (args[0] === "status") return {};
      return { Id: args[1], Provider: "claude-peer", Status: "running", Cwd: dir, Mode: "plan" };
    },
  });
  assert.equal(g.meta.scan.cwdUnresolved, 1);
  assert.equal(g.meta.scan.cwdUnresolvedDetail[0].id, "GONE");
  assert.match(g.meta.scan.cwdUnresolvedDetail[0].error, /ENOENT|no such file/i);
  assert.ok(!g.nodes.some((n) => n.id === "GONE"), "a different directory is still a different directory");
}

// ---------------------------------------------------------------------------
// Exit-code contract at the PROCESS boundary. Usage errors fail in parseArgs
// before any collection; the empty-scope control drives a real collection
// through a fake CLI to a real exit 3, so a refactor that breaks the exit code
// cannot stay green.
// ---------------------------------------------------------------------------

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
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

// KILLING TEST — exit 3 through the real producer (F011's untested boundary),
// on the empty-scope violation (U2). PASEO_TEAM_PASEO_EXEC points the script at
// a fake daemon: no real agents are touched, and the whole path — collect,
// assert, envelope, process.exitCode — executes.
{
  const dir = realpathSync(tmp("gg-cli-"));
  const elsewhere = realpathSync(tmp("gg-cli-other-"));
  const empty = join(dir, "empty-scope");
  mkdirSync(empty);
  const fake = join(dir, "fake-paseo.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
// Fake paseo for the exit-3 process-boundary control: one running agent, in a
// directory that is NOT the scope the CLI is asked about.
const argv = process.argv.slice(2);
const cwd = ${JSON.stringify(elsewhere)};
if (argv[0] === "ls") {
  console.log(JSON.stringify([{ id: "A1", shortId: "A1", provider: "claude-peer/claude-opus-5", status: "running", cwd }]));
} else if (argv[0] === "status") {
  console.log(JSON.stringify({ localDaemon: "running", daemonVersion: "0.6.1" }));
} else if (argv[0] === "inspect") {
  console.log(JSON.stringify({ Id: argv[1], Provider: "claude-peer", Status: "running", Cwd: cwd, Mode: "plan" }));
} else {
  console.log("{}");
}
`);

  const result = runCli(["--assert", "--cwd", empty], { PASEO_TEAM_PASEO_EXEC: `node "${fake}"` });
  assert.equal(result.status, 3, `empty scope must exit 3: ${result.stdout} ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.meta.scan.scopedTotal, 0);
  assert.equal(report.meta.scan.listedTotal, 1);
  const a6 = report.violations.filter((v) => v.rule.startsWith("A6"));
  assert.equal(a6.length, 1, `expected the empty-scope violation: ${JSON.stringify(report.violations)}`);
  assert.match(a6[0].evidence, /matched 0 of 1 listed agents/);

  // The same fake, scoped where the agent actually is, exits 0: the control has
  // a negative half, or it only proves the CLI can fail.
  const ok = runCli(["--assert", "--cwd", elsewhere], { PASEO_TEAM_PASEO_EXEC: `node "${fake}"` });
  assert.equal(ok.status, 0, `a populated scope with no violations must exit 0: ${ok.stdout} ${ok.stderr}`);
  assert.equal(JSON.parse(ok.stdout).ok, true);
}

// --help exits 0, documents --assert and its exit codes, and touches no daemon.
{
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--assert/);
  assert.match(result.stdout, /3 {2}violations found/);
  assert.match(result.stdout, /cannotVerify/);
  assert.match(result.stdout, /advisor/, "the help text admits which invariants are demoted");
}

console.log("governance-graph-assert tests passed");
