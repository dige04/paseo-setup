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
  SCHEMA_EPOCH,
  SCHEMA_EPOCH_MS,
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
//
// F015: a role-declared fixture agent CARRIES the matching harness.role record
// (labelRole = role), because that is what a compliant seat looks like after
// the sweep; a role="unknown" fixture carries none and is therefore the residue
// the A3 clause is about. `createdAt` defaults to the day before the schema
// epoch so an unlabelled fixture lands in the DECLARED cohort — a fixture that
// silently defaulted to post-epoch would turn every unknown-role graph in this
// file into an exit-3 violation.
const PRE_EPOCH = "2026-08-30T00:00:00.000Z";
const POST_EPOCH = "2026-09-01T00:00:00.000Z";
const agent = (id, role, {
  mode = null,
  cwd = "/w",
  canonicalCwd = undefined,
  status = "running",
  parentAgentId = null,
  provider = role === "unknown" ? "claude" : `claude-${role}`,
  modeLabel = null,
  labelRole = role === "unknown" ? null : role,
  createdAt = PRE_EPOCH,
} = {}) => ({
  id,
  shortId: id,
  name: id,
  role,
  labelRole,
  providerRole: undefined, // buildGraph derives it from the provider
  roleSource: labelRole ? "label" : role === "unknown" ? "none" : "provider",
  createdAt,
  provider,
  status,
  mode,
  modeLabel,
  cwd,
  canonicalCwd: canonicalCwd === undefined ? (cwd || null) : canonicalCwd,
  parentAgentId,
  pendingPermissions: [],
});

// Mark a fixture graph as an uncapped, fully inspected scan so A6 stays quiet,
// and as a COMPLETED role sweep so A3 evaluates the residue clause instead of
// reporting that no sweep ran — the same "declare the collection healthy so one
// invariant can be exercised in isolation" job in both halves.
const complete = (graph) => {
  const n = graph.meta.counts.tasks;
  graph.meta.scan = { listedTotal: n, scopedTotal: n, rendered: n, truncated: false, uninspected: 0 };
  graph.meta.partial = false;
  graph.meta.roleSweep = {
    key: "harness.role",
    values: ["supervisor", "lead", "peer"],
    known: true,
    labeled: graph.nodes.filter((node) => node.data?.roleSource === "label").length,
    errors: [],
  };
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
assert.deepEqual(Object.keys(ASSERT_RULES), ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]);
// A3's slug changed with its meaning: it no longer reports "no recognized
// provider suffix", it reports a missing governance RECORD, which is a
// different question with a different answer for the same agent.
assert.equal(ASSERT_RULES.A3, "missing-role-record-in-governed-scope");
assert.equal(ASSERT_RULES.A7, "role-record-vs-mechanism");
// A8 is deliberately not role-keyed: it names an ACT, because the seat it
// exists to catch has no role for a role-keyed rule to read.
assert.equal(ASSERT_RULES.A8, "unrecorded-orchestrator");
// The epoch is a recorded constant, not a computed "now": a moving epoch would
// re-judge yesterday's agents every morning.
assert.equal(SCHEMA_EPOCH, "2026-08-31T12:00:00Z");
assert.ok(Number.isFinite(SCHEMA_EPOCH_MS));

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
// SECONDARY CONTROL — the SUFFIX-sourced path. This block was A1's only
// positive control while it was synthetic: the branch needs a seat that is both
// role=peer and unenforced, and no shipped provider was both, so `omp-peer` was
// hand-built to make the specification executable. F015 retired it from that
// job — the load-bearing control is now the labelled-peer pair driven through
// the real CLI at the bottom of this file, on a shape shipped configs emit.
// It stays because the provider-suffix fallback is still live code for seats
// that carry no record, and this is the only test that reaches it.
// ---------------------------------------------------------------------------

{
  // labelRole: null on purpose — with a record these would take the label path
  // and this block would stop covering the fallback it exists to cover.
  const g = graphOf([
    agent("peer-1", "peer", { mode: "full", provider: "omp-peer", labelRole: null }),
    agent("peer-2", "peer", { mode: "full", provider: "omp-peer", labelRole: null }),
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
// A3 — THE RESIDUE CLAUSE: an agent in a governed scope carrying no
// harness.role record. Pre-epoch it is the DECLARED cohort (advisory, one line
// per scope); post-epoch it is a violation. F015 replaced the old reading
// ("no recognized provider suffix"), which reported a naming gap and had to be
// an advisory because the whole documented scout fleet tripped it.
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
  assert.match(a3[0].evidence, /DECLARED cohort/);
  assert.match(a3[0].evidence, /no backfill is planned/);
}

// KILLING TEST — the evidence must state what was MEASURED, not what was
// inferred. The sweep asks `--label harness.role=<v>` over a closed set; all it
// can observe is "answered to none of them". "Carries no harness.role record"
// is a stronger claim it cannot support, and it is FALSE for the eight
// scout-labelled agents live on this host — an operator who greps for the
// missing label finds one and stops trusting the line.
{
  const noCwd = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("nowhere", "unknown", { cwd: "" }),
  ]));
  const unresolvable = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("gone", "unknown", { cwd: "/gone", canonicalCwd: null }),
  ]));
  const noCreated = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("blind", "unknown", { createdAt: null }),
  ]));
  const cohort = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("old", "unknown", {}),
  ]));
  for (const [label, result] of [["no-cwd", noCwd], ["unresolvable", unresolvable], ["no-CreatedAt", noCreated], ["pre-epoch cohort", cohort]]) {
    const [line] = byRule(result.cannotVerify, "A3");
    assert.ok(line, `${label}: expected an A3 line`);
    assert.match(line.evidence, /answers? to no harness\.role value in \{supervisor, lead, peer\}/,
      `${label}: must report the measurement`);
    assert.ok(!/carr(y|ies) no harness\.role record/.test(line.evidence),
      `${label}: must not claim an absence the sweep cannot observe — it is false for a mislabelled agent`);
  }
}

// KILLING TEST — the "alongside" list names RECORD-CARRYING agents only.
// Sourcing it from the effective role listed the same provider-derived agent as
// governance and as residue one sentence apart, which reads as self-refuting.
{
  const { cannotVerify } = assertTopology(graphOf([
    agent("recorded", "lead", { mode: "plan" }),
    agent("suffix-only", "peer", { mode: "plan", provider: "claude-peer", labelRole: null }),
  ]));
  const [line] = byRule(cannotVerify, "A3");
  assert.ok(line.agents.includes("suffix-only"), "the suffix-only seat is residue");
  assert.match(line.evidence, /alongside record-carrying agents \[recorded\]/);
  assert.ok(
    !new RegExp("record-carrying agents \\[[^\\]]*suffix-only").test(line.evidence),
    "an agent inside the no-record cohort must never also be named as the governance it sits alongside",
  );
}

// A scope governed only by provider-derived roles says so rather than printing
// an empty list that reads like a rendering bug.
{
  const { cannotVerify } = assertTopology(graphOf([
    agent("suffix-a", "peer", { mode: "plan", provider: "claude-peer", labelRole: null }),
    agent("suffix-b", "unknown", { provider: "claude", labelRole: null }),
  ]));
  const [line] = byRule(cannotVerify, "A3");
  assert.match(line.evidence, /governance is provider-derived only — no agent here carries a record/);
}

// KILLING TEST — the residue clause's TEETH. Same shape, created AFTER the
// schema epoch: an agent that appears in no harness.role query while running in
// a governed scope is a violation, and this is the branch that makes F015
// enforceable rather than documented. Every one of the nine offenders measured
// on 2026-08-31 had this exact shape — an unarmed creator's child, no owner
// label, invisible to the reconciler, visible here.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("stray", "unknown", { createdAt: POST_EPOCH }),
  ]));
  const a3 = byRule(violations, "A3");
  assert.equal(a3.length, 1, `post-epoch residue must be a violation: ${JSON.stringify(violations)}`);
  assert.equal(a3[0].rule, "A3-missing-role-record-in-governed-scope");
  assert.deepEqual(a3[0].agents, ["stray"]);
  assert.match(a3[0].evidence, /after the F015 schema epoch/);
  assert.match(a3[0].evidence, /answers to no harness\.role value/);
  assert.deepEqual(byRule(cannotVerify, "A3"), [], "a decided agent produces no cannot-verify line as well");
}

// The epoch boundary is not "roughly a day": an agent created one millisecond
// before it is pre-epoch and one millisecond after it is not.
{
  const before = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("edge", "unknown", { createdAt: new Date(SCHEMA_EPOCH_MS).toISOString() }),
  ]));
  assert.deepEqual(byRule(before.violations, "A3"), [], "created AT the epoch is not created after it");
  const after = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("edge", "unknown", { createdAt: new Date(SCHEMA_EPOCH_MS + 1).toISOString() }),
  ]));
  assert.equal(byRule(after.violations, "A3").length, 1);
}

// A post-epoch agent whose inspect never answered has no epoch side to be
// judged on. One transient "Agent not found" was observed live; guessing there
// would convert a daemon hiccup into a governance violation.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("blind", "unknown", { createdAt: null }),
  ]));
  assert.deepEqual(byRule(violations, "A3"), []);
  const cv = byRule(cannotVerify, "A3");
  assert.equal(cv.length, 1);
  assert.equal(cv[0].advisory, undefined, "blindness is not the declared cohort");
  assert.match(cv[0].evidence, /no readable CreatedAt/);
}

// KILLING TEST (rolesKnown fail-closed twin) — a sweep that did not complete
// makes EVERY agent look unlabelled. The residue clause must go silent, not
// accuse the whole scope: this is the difference between a gate and an outage
// amplifier. Asserting "no violations" is the point; a cannotVerify line alone
// would pass even if the violations were also being emitted.
{
  const g = graphOf([
    agent("lead-1", "lead", { mode: "plan" }),
    agent("stray-1", "unknown", { createdAt: POST_EPOCH }),
    agent("stray-2", "unknown", { createdAt: POST_EPOCH }),
    // A pack-enforced seat with no swept record: without this the fixture
    // cannot reach A7's unconfirmed branch at all, and the twin would pass
    // while a failed sweep printed that line for the entire fleet.
    agent("pe", "peer", { mode: "plan", provider: "claude-peer", labelRole: null }),
  ]);
  g.meta.roleSweep = {
    key: "harness.role",
    values: ["supervisor", "lead", "peer"],
    known: false,
    labeled: 0,
    errors: ["harness.role=peer: paseo ls timed out"],
  };
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, [], "an incomplete sweep must never manufacture a violation");
  const a3 = byRule(cannotVerify, "A3");
  assert.equal(a3.length, 1, "one line for the failed sweep, not one per agent");
  assert.match(a3[0].evidence, /sweep did not complete/);
  assert.match(a3[0].evidence, /paseo ls timed out/, "the concrete reason travels with the admission");
  assert.match(a3[0].evidence, /fall back to the provider suffix/);
  assert.deepEqual(byRule(cannotVerify, "A7"), [],
    "with no usable sweep EVERY pack-enforced seat looks unconfirmed; one timed-out query must not print that line for the whole fleet");
}

// A graph with no sweep at all reaches the same A7 suppression by the other
// guard — the two conditions are separate and both must hold.
{
  const g = graphOf([agent("pe", "peer", { mode: "plan", provider: "claude-peer", labelRole: null })]);
  delete g.meta.roleSweep;
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, []);
  assert.deepEqual(byRule(cannotVerify, "A7"), []);
}

// A graph built with no sweep at all knows nothing about records, and says so
// once rather than either passing quietly or inventing a residue.
{
  const g = graphOf([agent("lead-1", "lead", { mode: "plan" }), agent("rando", "unknown", {})]);
  delete g.meta.roleSweep;
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, []);
  const a3 = byRule(cannotVerify, "A3");
  assert.equal(a3.length, 1);
  assert.match(a3[0].evidence, /meta\.roleSweep is absent/);
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
// A7 — record versus mechanism, and the ASYMMETRY is the rule.
//
// KILLING TEST: the same disagreement is a violation on a pack-enforced seat
// and only a cannot-verify everywhere else. On `claude-peer` the suffix is not
// a name — it selects the provider config that sets PASEO_CLAUDE_ROLE and arms
// the hook — so a label that contradicts it means the record the fleet is
// audited by describes a seat that is not the one running. On `omp` the suffix
// is text somebody typed, so two claims disagreeing proves nothing. Collapsing
// the two would either miss the real case or call every hand-named seat a
// violation.
// ---------------------------------------------------------------------------

{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("liar", "lead", { mode: "plan", provider: "claude-peer", labelRole: "lead" }),
  ]));
  const a7 = byRule(violations, "A7");
  assert.equal(a7.length, 1, `pack-enforced disagreement is a fact: ${JSON.stringify(violations)}`);
  assert.equal(a7[0].rule, "A7-role-record-vs-mechanism");
  assert.deepEqual(a7[0].agents, ["liar"]);
  assert.match(a7[0].evidence, /records harness\.role=lead/);
  assert.match(a7[0].evidence, /arms the hook as peer/);
  assert.match(a7[0].evidence, /the governance record disagrees with the mechanism/);
  assert.ok(
    !/wrong authority|is not a lead|invalid role/i.test(a7[0].evidence),
    "A7 reports a disagreement; it does not know which side is right and must not imply it does",
  );
  assert.deepEqual(byRule(cannotVerify, "A7"), []);
}

{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("claimer", "lead", { mode: "plan", provider: "omp-peer", labelRole: "lead" }),
  ]));
  assert.deepEqual(byRule(violations, "A7"), [], "a hand-made suffix is not a mechanism to be contradicted");
  const a7 = byRule(cannotVerify, "A7");
  assert.equal(a7.length, 1);
  assert.deepEqual(a7[0].agents, ["claimer"]);
  assert.match(a7[0].evidence, /hand-made text and not a mechanism/);
}

// KILLING TEST — A7's THIRD STATE: a pack-enforced seat whose record does not
// CONFIRM the mechanism. Before this the rule skipped every seat with
// roleSource !== "label", so a `claude-peer` carrying an out-of-vocabulary
// record was structurally invisible — no violation, and not even a
// cannotVerify. Two such seats exist live on this host (`harness.role=scout`
// on claude-peer, measured 2026-08-31), so the blind spot was occupied, not
// theoretical.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("recorded", "peer", { mode: "plan", provider: "claude-peer" }),
    agent("unconfirmed", "peer", { mode: "plan", provider: "claude-peer", labelRole: null }),
  ]));
  const a7 = byRule(cannotVerify, "A7");
  assert.equal(a7.length, 1, `an unconfirmed pack-enforced seat must not be silent: ${JSON.stringify(cannotVerify)}`);
  assert.deepEqual(a7[0].agents, ["unconfirmed"], "a confirmed seat is not swept into the line with it");
  assert.match(a7[0].evidence, /answer to no harness\.role value in \{supervisor, lead, peer\}/);
  assert.match(a7[0].evidence, /claude-peer arms the hook as peer/);
  assert.match(a7[0].evidence, /UNLABELLED or carries a value outside the closed set is not decidable here/);
  assert.match(a7[0].evidence, /no existence selector and no negation/);

  // NOT a violation, and NOT an advisory. The population is a mixture —
  // measured live: 2 of 12 carry a wrong value, 10 carry no label at all — so
  // "the record disagrees with the mechanism" would be a false statement about
  // the other ten. And the signal genuinely cannot be read, which is blindness,
  // not a check demoted because its evidence is weak.
  assert.deepEqual(byRule(violations, "A7"), [],
    "an unreadable record is not a disagreement; manufacturing one is the failure this rule guards against");
  assert.equal(a7[0].advisory, undefined, "blindness is not an advisory; they are different admissions");
}

// A seat with no role suffix asserts no mechanism, so there is nothing for a
// record to confirm and nothing to report.
{
  const { cannotVerify } = assertTopology(graphOf([
    agent("recorded", "peer", { mode: "plan", provider: "claude-peer" }),
    agent("bare", "unknown", { mode: "plan", provider: "claude", labelRole: null }),
  ]));
  assert.deepEqual(byRule(cannotVerify, "A7"), [], "no suffix, no mechanism, no A7 claim");
}

// One line per scope, not one per seat — the same flood control A1's
// pack-enforced note uses. Twelve unconfirmed seats is this repo's real number.
{
  const fleet = [agent("recorded", "peer", { mode: "plan", provider: "claude-peer" })];
  for (let i = 0; i < 12; i++) {
    fleet.push(agent(`pe-${i}`, "peer", { mode: "plan", provider: "claude-peer", labelRole: null, status: "idle" }));
  }
  const a7 = byRule(assertTopology(graphOf(fleet)).cannotVerify, "A7");
  assert.equal(a7.length, 1, "one line for the scope");
  assert.equal(a7[0].agents.length, 12, "all twelve are named in it");
}

// Agreement proves nothing either — it is simply silent. A label on a provider
// with no suffix at all is the INCLUSION case: the claim brings an unenforced
// seat into the audited population, and there is nothing to disagree with.
{
  const quiet = assertTopology(graphOf([
    agent("agrees", "peer", { mode: "plan", provider: "claude-peer" }),
    agent("included", "peer", { mode: "plan", provider: "omp", cwd: "/w2", labelRole: "peer" }),
  ]));
  assert.deepEqual(byRule(quiet.violations, "A7"), []);
  assert.deepEqual(byRule(quiet.cannotVerify, "A7"), []);
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

// A CLOSED supervisor's delegation edge is finished history. It stays reported,
// with the same evidence, but it does not hold the gate red: exit 3 means "fix
// the topology before dispatching", and there is no operation on today's
// topology that clears an edge a dead agent created. Measured 2026-09-01: one
// closed supervisor from 2026-08-22 held --assert at exit 3 on every scope, and
// a gate that can never go green stops being read.
for (const status of ["closed", "idle"]) {
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("sup", "supervisor", { mode: "plan", status }),
    agent("peer-1", "peer", { mode: "plan", parentAgentId: "sup" }),
  ]));
  assert.deepEqual(byRule(violations, "A5"), [],
    `a ${status} supervisor's delegation edge is not actionable and must not be a violation`);
  const cv = byRule(cannotVerify, "A5").filter((e) => e.id.endsWith(":closed-delegation"));
  assert.equal(cv.length, 1, `the edge must still be REPORTED for a ${status} supervisor`);
  assert.equal(cv[0].advisory, true);
  assert.deepEqual(cv[0].agents, ["peer-1", "sup"]);
  // Demoted, not laundered: the advisory must still say the thing happened.
  assert.match(cv[0].evidence, /parents delegation edge/);
  assert.match(cv[0].evidence, /recorded, not excused/);
  assert.match(cv[0].evidence, new RegExp(`status ${status}`));
}

// The discrimination itself: same two agents, only the supervisor's status
// differs, and the verdict flips. Without this the split above is
// indistinguishable from switching A5's delegation leg off.
{
  const build = (status) => assertTopology(graphOf([
    agent("sup", "supervisor", { mode: "plan", status }),
    agent("peer-1", "peer", { mode: "plan", parentAgentId: "sup" }),
  ]));
  assert.equal(byRule(build("running").violations, "A5").length, 1, "live supervisor: violation");
  assert.equal(byRule(build("closed").violations, "A5").length, 0, "closed supervisor: advisory");
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
// A8 — orchestration with no authority record. This is the gap between A4 and
// A5: both need a ROLE before they can judge an orchestrator, and the seat that
// matters most has none. A standing Lead on bare `claude` carries no suffix the
// pack reads and no label, so it resolves to role=unknown and every role-keyed
// rule falls through it — while being the one seat whose children arrive
// unaccounted for.
// ---------------------------------------------------------------------------

{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("boss", "unknown", { mode: "bypassPermissions" }),
    agent("kid-1", "unknown", { mode: "plan", parentAgentId: "boss" }),
  ]));
  assert.deepEqual(byRule(violations, "A8"), [], "A8 never blocks: prevention is not available here");
  const a8 = byRule(cannotVerify, "A8");
  assert.equal(a8.length, 1, "an unrecorded orchestrator must be reported");
  assert.equal(a8[0].advisory, true);
  assert.deepEqual(a8[0].agents, ["boss", "kid-1"]);
  assert.match(a8[0].evidence, /parents delegation edge/);
  assert.match(a8[0].evidence, /no authority record behind it/);
  // The attribution A3 cannot supply: which seat made the unlabelled strays.
  assert.match(a8[0].evidence, /1 of the 1 agent\(s\) it created carry no harness\.role record either/);
  assert.match(a8[0].evidence, /binds by CREATOR/);
}

// It says the opposite just as plainly. If the children DO carry records, the
// gate did not fire from this seat, and the advisory must not imply it did.
{
  const { cannotVerify } = assertTopology(graphOf([
    agent("boss", "unknown", { mode: "bypassPermissions" }),
    agent("kid-1", "peer", { mode: "plan", parentAgentId: "boss", provider: "omp", labelRole: "peer" }),
  ]));
  const a8 = byRule(cannotVerify, "A8");
  assert.equal(a8.length, 1);
  assert.match(a8[0].evidence, /every agent it created does carry a record/);
  assert.match(a8[0].evidence, /the gate did not fire from here/);
}

// No double-counting. A4 and A5 already own the orchestrators whose role IS
// known; reporting them again under A8 would bill one seat to two rules and
// inflate every count downstream of the assert.
//
// `labelRole: null` is the whole point of this fixture and not a detail. With a
// label the seat would be skipped for carrying a record, and the test would pass
// while proving nothing about the role guard — which is exactly how the first
// version of it let a double-counting mutation survive. Here the role comes from
// the PROVIDER SUFFIX alone, so the role guard is the only thing that can stop
// A8 firing.
for (const [role, owner] of [["peer", "A4"], ["supervisor", "A5"]]) {
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("boss", role, { mode: "plan", labelRole: null }),
    agent("kid-1", "peer", { mode: "plan", parentAgentId: "boss", labelRole: null }),
  ]));
  assert.equal(byRule(violations, owner).length, 1, `${owner} still owns a ${role} orchestrator`);
  assert.deepEqual(byRule(cannotVerify, "A8"), [], `A8 must not double-count the ${role} case`);
}

// A LEAD that orchestrates is the intended shape, and it must stay silent even
// when it carries no label — the role is legible from the provider suffix, which
// is the mechanism arming the hook on that seat.
{
  const { violations, cannotVerify } = assertTopology(graphOf([
    agent("lead-1", "lead", { mode: "plan", labelRole: null }),
    agent("kid-1", "peer", { mode: "plan", parentAgentId: "lead-1", labelRole: null }),
  ]));
  assert.deepEqual(byRule(violations, "A8"), []);
  assert.deepEqual(byRule(cannotVerify, "A8"), [], "a lead dispatching peers is the shape this pack is for");
}

// The discrimination, on one axis: identical topology, and the ONLY difference
// is whether the orchestrator's seat carries a legible role. That is the line
// A8 draws, so it is asserted directly rather than inferred from two fixtures.
{
  const build = (bossRole, provider) => assertTopology(graphOf([
    agent("boss", bossRole, { mode: "bypassPermissions", labelRole: null, provider }),
    agent("kid-1", "unknown", { mode: "plan", parentAgentId: "boss", labelRole: null }),
  ]));
  assert.equal(byRule(build("lead", "claude-lead").cannotVerify, "A8").length, 0, "legible seat: silent");
  assert.equal(byRule(build("unknown", "claude").cannotVerify, "A8").length, 1, "illegible seat: reported");
}

// An agent that orchestrates nothing is not an orchestrator, whatever it lacks.
{
  const { cannotVerify } = assertTopology(graphOf([agent("solo", "unknown", { mode: "bypassPermissions" })]));
  assert.deepEqual(byRule(cannotVerify, "A8"), []);
}

// Guarded on the sweep, exactly as A3's residue clause is. With an incomplete
// sweep every agent looks unlabelled, and this rule would accuse every
// orchestrator on the fleet at once for a reason that is about the sweep.
{
  const g = graphOf([
    agent("boss", "unknown", { mode: "bypassPermissions" }),
    agent("kid-1", "unknown", { mode: "plan", parentAgentId: "boss" }),
  ]);
  g.meta.roleSweep = { known: false, errors: ["daemon refused the selector"] };
  assert.deepEqual(byRule(assertTopology(g).cannotVerify, "A8"), [],
    "an incomplete sweep must suppress A8, not accuse everyone");
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
//
// The fake answers `--label` the way the daemon does — exact match on one
// key=value, empty for the rest — because "fully verifiable" now requires a
// completed role sweep too. A fake that ignored the selector would return the
// whole list for all three values, which is the KEY-ONLY FAIL-OPEN shape
// (measured: `--label harness.role` returned all 200 agents) and would make
// this fixture certify a sweep the real daemon never performed.
{
  const dir = realpathSync(tmp("gg-clean-"));
  const listed = [{ id: "P1", shortId: "P1", provider: "agy-peer/x", status: "running", cwd: dir }];
  const g = await collectGraph({
    cwd: dir,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") {
        const selector = args[args.indexOf("--label") + 1];
        if (!args.includes("--label")) return listed;
        return selector === "harness.role=peer" ? listed : [];
      }
      if (args[0] === "status") return {};
      return { Id: "P1", Provider: "agy-peer", Status: "running", Cwd: dir, Mode: "plan", CreatedAt: "2026-08-30T00:00:00.000Z" };
    },
  });
  assert.equal(g.meta.partial, false);
  assert.deepEqual(g.meta.roleSweep, {
    key: "harness.role",
    values: ["supervisor", "lead", "peer"],
    known: true,
    labeled: 1,
    errors: [],
  });
  const { violations, cannotVerify } = assertTopology(g);
  assert.deepEqual(violations, []);
  assert.deepEqual(cannotVerify, []);
}

// KILLING TEST — the residue clause through the REAL PRODUCER. The block in
// the A3 section builds a graph object and calls assertTopology; that is
// fixture injection, and AP-02 is explicit that a fail-closed gate's positive
// path is not evidence until it has been reached through the producer. Here
// the label sweep really runs, really returns "not this one", and the CreatedAt
// really comes off inspect — the three signals the clause conjoins.
{
  const dir = realpathSync(tmp("gg-residue-"));
  const listed = [
    { id: "LEAD", shortId: "LEAD", provider: "claude-lead/opus", status: "running", cwd: dir },
    { id: "STRAY", shortId: "STRAY", provider: "omp/gemini", status: "running", cwd: dir },
  ];
  const g = await collectGraph({
    cwd: dir,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") {
        if (!args.includes("--label")) return listed;
        // Only the lead is labelled. STRAY is the residue: it appears in the
        // base list and in NO role query, which is the only way the daemon can
        // express "unlabelled" — there is no existence selector to ask with.
        return args.at(-1) === "harness.role=lead" ? [listed[0]] : [];
      }
      if (args[0] === "status") return {};
      return {
        Id: args[1],
        Provider: args[1] === "LEAD" ? "claude-lead" : "omp",
        Status: "running",
        Cwd: dir,
        Mode: args[1] === "LEAD" ? "plan" : "ask",
        CreatedAt: args[1] === "LEAD" ? "2026-08-30T00:00:00.000Z" : "2026-09-01T09:00:00.000Z",
      };
    },
  });

  assert.equal(g.meta.roleSweep.known, true);
  assert.equal(g.meta.roleSweep.labeled, 1, "the sweep found exactly one record");
  const stray = g.nodes.find((n) => n.id === "STRAY");
  assert.equal(stray.data.roleSource, "none", "no record and no suffix");
  assert.equal(g.nodes.find((n) => n.id === "LEAD").data.roleSource, "label");

  const { violations } = assertTopology(g);
  const a3 = byRule(violations, "A3");
  assert.equal(a3.length, 1, `post-epoch residue must reach exit 3 through collection: ${JSON.stringify(violations)}`);
  assert.deepEqual(a3[0].agents, ["STRAY"]);
  assert.match(a3[0].evidence, /after the F015 schema epoch/);
  assert.match(a3[0].evidence, new RegExp(`governed scope ${dir}`));

  // The negative half: the same collection with a pre-epoch CreatedAt is the
  // DECLARED cohort and must not fail a build. Without this the test proves
  // only that A3 can fire, not that the epoch is what decides it.
  const older = await collectGraph({
    cwd: dir,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") {
        if (!args.includes("--label")) return listed;
        return args.at(-1) === "harness.role=lead" ? [listed[0]] : [];
      }
      if (args[0] === "status") return {};
      return {
        Id: args[1],
        Provider: args[1] === "LEAD" ? "claude-lead" : "omp",
        Status: "running",
        Cwd: dir,
        Mode: args[1] === "LEAD" ? "plan" : "ask",
        CreatedAt: "2026-08-30T00:00:00.000Z",
      };
    },
  });
  const olderResult = assertTopology(older);
  assert.deepEqual(byRule(olderResult.violations, "A3"), []);
  const cohort = byRule(olderResult.cannotVerify, "A3");
  assert.equal(cohort.length, 1);
  assert.equal(cohort[0].advisory, true);
  assert.deepEqual(cohort[0].agents, ["STRAY"]);
}

// KILLING TEST — THE LIVE BLIND SPOT, through the real producer: a
// pack-enforced seat carrying an OUT-OF-VOCABULARY record.
//
// This is the measured shape, not an invented one: on this host
// `paseo ls --label harness.role=scout` returns 8 agents and two of them are
// `claude-peer`. The fake reproduces exactly that — the seat answers the
// `scout` query and none of the swept values — which is the whole point: the
// sweep asks only over the closed set, so a wrong record and a missing record
// arrive as the same silence. Before this round A7 skipped both and said
// nothing at all.
//
// It also proves why more queries do not close it. The fake answers
// `harness.role=repository-scout` with nothing, exactly as the live daemon
// does: the wrong values in the wild are informal SHORT names, so even probing
// the entire Layer-2 vocabulary — five extra spawns — would find none of them.
{
  const dir = realpathSync(tmp("gg-oov-"));
  const listed = [
    { id: "GOOD", shortId: "GOOD", provider: "claude-peer/opus", status: "running", cwd: dir },
    { id: "SCOUT", shortId: "SCOUT", provider: "claude-peer/sonnet", status: "idle", cwd: dir },
  ];
  const answers = {
    "harness.role=peer": [listed[0]],
    "harness.role=scout": [listed[1]], // the real label, and nothing asks for it
  };
  const g = await collectGraph({
    cwd: dir,
    maxAttempts: 1,
    runPaseoJson: async (args) => {
      if (args[0] === "ls") {
        if (!args.includes("--label")) return listed;
        return answers[args.at(-1)] ?? [];
      }
      if (args[0] === "status") return {};
      return {
        Id: args[1],
        Provider: "claude-peer",
        Status: args[1] === "GOOD" ? "running" : "idle",
        Cwd: dir,
        Mode: "plan",
        CreatedAt: "2026-08-30T00:00:00.000Z",
      };
    },
  });

  // The sweep genuinely cannot see it — that is the premise, and it is asserted
  // rather than assumed, or the test would be proving something easier.
  assert.equal(g.meta.roleSweep.known, true);
  assert.equal(g.meta.roleSweep.labeled, 1, "only the compliant seat answered a swept value");
  assert.equal(g.nodes.find((n) => n.id === "SCOUT").data.roleSource, "provider",
    "a wrong record is indistinguishable from no record at the sweep layer");

  const { violations, cannotVerify } = assertTopology(g);
  const a7 = byRule(cannotVerify, "A7");
  assert.equal(a7.length, 1, `the seat must be visible: ${JSON.stringify(cannotVerify)}`);
  assert.deepEqual(a7[0].agents, ["SCOUT"]);
  assert.match(a7[0].evidence, /does not confirm the mechanism that bounds them/);
  assert.deepEqual(byRule(violations, "A7"), [], "visible, but not accused of a disagreement it cannot prove");

  // Pre-epoch, so A3 keeps it in the declared cohort — the two rules report the
  // same seat for different reasons and neither one exits 3 for it.
  assert.deepEqual(violations, []);
  assert.equal(byRule(cannotVerify, "A3").filter((e) => e.advisory === true).length, 1);
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

// ---------------------------------------------------------------------------
// KILLING TEST — A1's TRUE-POSITIVE BRANCH, through the real producer.
//
// This is the test the F015 ruling named, and it is the one that retires the
// synthetic control above. Two RUNNING seats on an unenforced provider (`omp`,
// Mode `full` = Full Access = a standing grant), in ONE canonical scope, each
// carrying `harness.role=peer` — a shape shipped configs emit, not a
// hand-built provider name. It runs the whole path the operator runs: the CLI
// entrypoint, a real collection against a fake daemon over
// PASEO_TEAM_PASEO_EXEC, the label sweep, the assert layer, the JSON envelope
// and process.exitCode.
//
// EXACTLY ONE violation, not "at least one": the branch is worthless if it
// arrives bundled with residue or A7 noise, so the fake labels both seats and
// dates them pre-epoch. Before F015 this branch could not be reached at all —
// role was read off a suffix only pack-enforced providers carry, so
// "peer AND unenforced" was empty on every fleet the pack could produce.
//
// The negative half is not decoration: without it this proves only that the
// CLI can exit 3, not that A1 discriminates.
// ---------------------------------------------------------------------------
{
  const dir = realpathSync(tmp("gg-a1-"));
  const scope = join(dir, "scope");
  mkdirSync(scope);

  // `secondStatus` is the only difference between the two halves.
  const fakeFor = (name, secondStatus) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env node
// Fake paseo for A1's true-positive control. Two omp seats, one scope, both
// labelled harness.role=peer. --label is answered the way the daemon answers
// it: exact match on one key=value. Returning the full list regardless of the
// selector would be the measured key-only FAIL-OPEN, and would make every
// agent look labelled with every role.
const argv = process.argv.slice(2);
const cwd = ${JSON.stringify(scope)};
const AGENTS = [
  { id: "OMP-1", shortId: "OMP-1", provider: "omp/google-antigravity/gemini-3.7-flash", status: "running", cwd },
  { id: "OMP-2", shortId: "OMP-2", provider: "omp/google-antigravity/gemini-3.7-flash", status: ${JSON.stringify(secondStatus)}, cwd },
];
if (argv[0] === "ls") {
  const at = argv.indexOf("--label");
  if (at === -1) { console.log(JSON.stringify(AGENTS)); }
  else { console.log(JSON.stringify(argv[at + 1] === "harness.role=peer" ? AGENTS : [])); }
} else if (argv[0] === "status") {
  console.log(JSON.stringify({ localDaemon: "running", daemonVersion: "0.6.1" }));
} else if (argv[0] === "inspect") {
  const agent = AGENTS.find((a) => a.id === argv[1]);
  console.log(JSON.stringify({
    Id: agent.id,
    Provider: "omp",
    Status: agent.status,
    Cwd: cwd,
    Mode: "full",
    // Pre-epoch: this control is about A1, and a post-epoch date would add an
    // A3 residue violation and break the exactly-one claim for the wrong reason.
    CreatedAt: "2026-08-30T00:00:00.000Z",
    AvailableModes: [{ id: "full", label: "Full Access" }, { id: "write", label: "Write Approval" }],
  }));
} else {
  console.log("{}");
}
`);
    return path;
  };

  const bothRunning = runCli(["--assert", "--cwd", scope], {
    PASEO_TEAM_PASEO_EXEC: `node "${fakeFor("fake-a1-live.mjs", "running")}"`,
  });
  assert.equal(bothRunning.status, 3,
    `two running labelled unenforced peers must exit 3: ${bothRunning.stdout} ${bothRunning.stderr}`);
  const report = JSON.parse(bothRunning.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 1,
    `exactly one violation, nothing bundled: ${JSON.stringify(report.violations, null, 2)}`);
  assert.equal(report.violations[0].rule, "A1-one-writer-per-scope");
  assert.deepEqual(report.violations[0].agents, ["OMP-1", "OMP-2"]);
  assert.match(report.violations[0].evidence, /2 running write-capable peers share scope/);
  assert.match(report.violations[0].evidence, /no mechanism in this pack bounds their writes/);
  // The role really came from the sweep, not from a suffix `omp` does not have.
  assert.equal(report.meta.roleSweep.known, true);
  assert.equal(report.meta.roleSweep.labeled, 2);
  assert.equal(report.meta.schemaEpoch, SCHEMA_EPOCH);

  const oneIdle = runCli(["--assert", "--cwd", scope], {
    PASEO_TEAM_PASEO_EXEC: `node "${fakeFor("fake-a1-idle.mjs", "idle")}"`,
  });
  assert.equal(oneIdle.status, 0,
    `one writer plus an idle seat is the daily handover, not a violation: ${oneIdle.stdout} ${oneIdle.stderr}`);
  const idleReport = JSON.parse(oneIdle.stdout);
  assert.equal(idleReport.ok, true);
  assert.equal(idleReport.violations.length, 0);
  assert.equal(
    idleReport.cannotVerify.filter((e) => e.advisory === true && e.id.endsWith(":idle-write-capable")).length,
    1,
    "the idle seat is one advisory naming the tool that owns the retire decision",
  );
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

// ---------------------------------------------------------------------------
// KILLING TEST — A5's delegation leg, through the REAL CLI, both halves.
//
// The unit tests above prove assertTopology() discriminates. They cannot prove
// the CLI still exits 3, and that is exactly what the liveness split put at
// risk: demoting the closed case is one edit away from demoting the live one,
// and every unit test would stay green while the morning gate went quiet.
//
// The negative half carries equal weight. It is the measured production case —
// a closed supervisor whose finished delegation edge held --assert at exit 3 on
// every scope — and it must exit 0 while still REPORTING the edge.
// ---------------------------------------------------------------------------
{
  const dir = realpathSync(tmp("gg-a5-"));
  const scope = join(dir, "scope");
  mkdirSync(scope);

  // `supStatus` is the only difference between the two halves.
  const fakeFor = (name, supStatus) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env node
// Fake paseo for A5's delegation control. A supervisor that parents one peer.
// Both seats are pack-enforced and pre-epoch so the run carries no A3 residue
// and no A7 noise — the "exactly one violation" claim has to be about A5.
const argv = process.argv.slice(2);
const cwd = ${JSON.stringify(scope)};
const AGENTS = [
  { id: "SUP-1", shortId: "SUP-1", provider: "claude-supervisor/claude-opus-5", status: ${JSON.stringify(supStatus)}, cwd },
  { id: "PEER-1", shortId: "PEER-1", provider: "claude-peer/claude-opus-5", status: "running", cwd },
];
const ROLE = { "SUP-1": "supervisor", "PEER-1": "peer" };
if (argv[0] === "ls") {
  const at = argv.indexOf("--label");
  if (at === -1) { console.log(JSON.stringify(AGENTS)); }
  else {
    const want = String(argv[at + 1]).split("=")[1];
    console.log(JSON.stringify(AGENTS.filter((a) => ROLE[a.id] === want)));
  }
} else if (argv[0] === "status") {
  console.log(JSON.stringify({ localDaemon: "running", daemonVersion: "0.6.1" }));
} else if (argv[0] === "inspect") {
  const agent = AGENTS.find((a) => a.id === argv[1]);
  console.log(JSON.stringify({
    Id: agent.id,
    Provider: agent.provider,
    Status: agent.status,
    Cwd: cwd,
    Mode: "plan",
    ParentAgentId: agent.id === "PEER-1" ? "SUP-1" : null,
    CreatedAt: "2026-08-30T00:00:00.000Z",
    AvailableModes: [{ id: "plan", label: "Plan Mode" }],
  }));
} else {
  console.log("{}");
}
`);
    return path;
  };

  const live = runCli(["--assert", "--cwd", scope], {
    PASEO_TEAM_PASEO_EXEC: `node "${fakeFor("fake-a5-live.mjs", "running")}"`,
  });
  assert.equal(live.status, 3,
    `a RUNNING supervisor that orchestrates must exit 3: ${live.stdout} ${live.stderr}`);
  const liveReport = JSON.parse(live.stdout);
  assert.equal(liveReport.ok, false);
  assert.equal(liveReport.violations.length, 1,
    `exactly one violation, nothing bundled: ${JSON.stringify(liveReport.violations, null, 2)}`);
  assert.equal(liveReport.violations[0].rule, "A5-supervisor-not-observe-only");
  assert.deepEqual(liveReport.violations[0].agents, ["PEER-1", "SUP-1"]);
  assert.match(liveReport.violations[0].evidence, /observe-only and never orchestrates/);

  const closed = runCli(["--assert", "--cwd", scope], {
    PASEO_TEAM_PASEO_EXEC: `node "${fakeFor("fake-a5-closed.mjs", "closed")}"`,
  });
  assert.equal(closed.status, 0,
    `a CLOSED supervisor's finished edge must not hold the gate red: ${closed.stdout} ${closed.stderr}`);
  const closedReport = JSON.parse(closed.stdout);
  assert.equal(closedReport.ok, true);
  assert.equal(closedReport.violations.length, 0);
  const demoted = closedReport.cannotVerify.filter(
    (e) => e.advisory === true && e.id.endsWith(":closed-delegation"));
  assert.equal(demoted.length, 1, "green must not mean silent — the edge is still reported");
  assert.match(demoted[0].evidence, /recorded, not excused/);
}

console.log("governance-graph-assert tests passed");
