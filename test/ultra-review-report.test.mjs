// ultra-review-report.test.mjs — artifact contract for the ultra-review scaffold.
// Run: node test/ultra-review-report.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATE_FIELDS,
  GATE_MARKER_LINE,
  ULTRA_REVIEW_ERROR_CODES,
  checkReportGate,
  findingAction,
  markdownTemplate,
  nextRound,
  parseGateLine,
  parseReport,
  slugify,
} from "../scripts/ultra-review-report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "ultra-review-report.mjs");
const NODE = process.execPath;
const SHA = "a".repeat(64);

function run(args, cwd = ROOT) {
  const result = spawnSync(NODE, [SCRIPT, ...args], { encoding: "utf8", cwd, timeout: 30_000 });
  let json = null;
  const firstBlock = result.stdout.split("---BEGIN ULTRA REVIEW TEMPLATE---")[0];
  try {
    json = JSON.parse(firstBlock);
  } catch {
    json = null;
  }
  return { ...result, json };
}

const workspace = () => mkdtempSync(join(tmpdir(), "paseo-ultra-review-"));

// --- slug -------------------------------------------------------------------

assert.equal(slugify("Checkout Discount Review"), "checkout-discount-review");
assert.equal(slugify("  A//B  "), "a-b");
// An empty slug would collide every review into one filename, so it must throw
// rather than silently produce "".
assert.throws(() => slugify("///"), (error) => error.code === "USAGE");
assert.throws(() => slugify(""), (error) => error.code === "USAGE");

// --- round derivation -------------------------------------------------------

{
  const dir = workspace();
  assert.deepEqual(nextRound(join(dir, "missing"), "demo"), { round: 1, priorReports: [] });

  writeFileSync(join(dir, "26-08-20-demo-round-1.md"), "x");
  writeFileSync(join(dir, "26-08-21-demo-round-2.md"), "x");
  // Same-prefix names of a DIFFERENT review must not bump this review's round.
  writeFileSync(join(dir, "26-08-21-demo-other-round-9.md"), "x");
  // Unrelated files in the directory must be ignored entirely.
  writeFileSync(join(dir, "notes.md"), "x");
  const { round, priorReports } = nextRound(dir, "demo");
  assert.equal(round, 3);
  assert.deepEqual(priorReports, ["26-08-20-demo-round-1.md", "26-08-21-demo-round-2.md"]);
}

// Round 10 must follow round 9 — a lexical sort would place round-10 before
// round-2 and silently reuse an existing round number.
{
  const dir = workspace();
  for (const n of [1, 2, 9, 10]) writeFileSync(join(dir, `26-08-2${n % 10}-demo-round-${n}.md`), "x");
  assert.equal(nextRound(dir, "demo").round, 11);
}

// --- argument validation ----------------------------------------------------

const baseArgs = (dir) => [
  "--workspace", dir,
  "--review-name", "demo",
  "--scope", "the checkout flow",
  "--review-brief-sha256", SHA,
  "--scout-count", "10",
  "--directive-count", "0",
];

for (const [args, label] of [
  [["--review-name", "demo"], "missing scope"],
  [["--scope", "s", "--review-brief-sha256", SHA, "--scout-count", "10", "--directive-count", "0"], "missing review name"],
  [["--review-name", "demo", "--scope", "s", "--review-brief-sha256", "short", "--scout-count", "10", "--directive-count", "0"], "short sha"],
  [["--review-name", "demo", "--scope", "s", "--review-brief-sha256", SHA.toUpperCase(), "--scout-count", "10", "--directive-count", "0"], "uppercase sha"],
  [["--review-name", "demo", "--scope", "s", "--review-brief-sha256", SHA, "--scout-count", "0", "--directive-count", "0"], "zero scouts"],
  [["--review-name", "demo", "--scope", "s", "--review-brief-sha256", SHA, "--scout-count", "ten", "--directive-count", "0"], "non-numeric scouts"],
  [["--review-name", "demo", "--scope", "s", "--review-brief-sha256", SHA, "--scout-count", "10", "--directive-count", "-1"], "negative directives"],
  [["--review-name", "demo", "--scope", "s", "--review-brief-sha256", SHA, "--scout-count", "10", "--directive-count", "0", "--date", "2026-08-22"], "wrong date format"],
  [["--review-name", "demo", "--scope", "s", "--review-brief-sha256", SHA, "--scout-count", "10", "--directive-count", "0", "--bogus", "x"], "unknown flag"],
]) {
  const result = run(args);
  assert.equal(result.status, 2, label);
  assert.equal(result.json.code, "USAGE", label);
}

// A missing workspace is reported as such, not created implicitly.
{
  const result = run([...baseArgs(join(workspace(), "nope")), "--dry-run"]);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "WORKSPACE_MISSING");
}

// --- writing ----------------------------------------------------------------

{
  const dir = workspace();
  const result = run([...baseArgs(dir), "--date", "26-08-22"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.schema, "paseo.ultra-review-report/v1");
  assert.equal(result.json.round, 1);
  assert.equal(result.json.report_path, "docs/ultrareview/26-08-22-demo-round-1.md");
  assert.deepEqual(result.json.prior_reports, []);
  assert.equal(result.json.scout_count, 10);
  const written = readFileSync(join(dir, "docs", "ultrareview", "26-08-22-demo-round-1.md"), "utf8");
  assert.match(written, /# Ultra Review: demo Round 1/);
  assert.match(written, /Review brief SHA256: a{64}/);
  // Gate: v1 is the report's opt-in to the strict grammar — a report lacking
  // it is declared pre-gate, never inferred finding-by-finding.
  assert.match(written, /^Gate: v1$/m);
  // The roster and the missing-scout accounting are the anti-silent-partial
  // mechanism; a template without them lets a lost scout read as coverage.
  assert.match(written, /## Scout Roster/);
  assert.match(written, /SCOUTS_MISSING:/);
  assert.match(written, /## Verification Queue/);
  // Exactly one artifact — the report and its two parent directories.
  assert.deepEqual(readdirSync(dir), ["docs"]);
  assert.deepEqual(readdirSync(join(dir, "docs", "ultrareview")), ["26-08-22-demo-round-1.md"]);

  // Round 2 discovers round 1 from disk and cites it.
  const second = run([...baseArgs(dir), "--date", "26-08-23"]);
  assert.equal(second.status, 0);
  assert.equal(second.json.round, 2);
  assert.deepEqual(second.json.prior_reports, ["docs/ultrareview/26-08-22-demo-round-1.md"]);
  assert.match(
    readFileSync(join(dir, second.json.report_path), "utf8"),
    /- docs\/ultrareview\/26-08-22-demo-round-1\.md/,
  );

  // Re-running on the same day must never clobber a report that already holds
  // consolidated findings — it advances the round instead. This is the property
  // that protects a Lead who lost context and restarted: rounds only move
  // forward, and earlier evidence survives.
  const marked = join(dir, second.json.report_path);
  writeFileSync(marked, `${readFileSync(marked, "utf8")}\nCONSOLIDATED-FINDINGS-MARKER\n`);
  const third = run([...baseArgs(dir), "--date", "26-08-23"]);
  assert.equal(third.status, 0);
  assert.equal(third.json.round, 3);
  assert.notEqual(third.json.report_path, second.json.report_path);
  assert.match(readFileSync(marked, "utf8"), /CONSOLIDATED-FINDINGS-MARKER/);
}

// REPORT_EXISTS is a TOCTOU backstop, not a reachable single-caller state:
// nextRound() always returns max+1 over the files on disk, so one caller can
// never compute a path that already exists. It fires only when a second writer
// creates the file between the directory scan and the write. Asserting it is
// exported keeps the code honest without fabricating a test-only parameter to
// reach the branch.
assert.ok(ULTRA_REVIEW_ERROR_CODES.includes("REPORT_EXISTS"));
assert.ok(ULTRA_REVIEW_ERROR_CODES.includes("WORKSPACE_MISSING"));
assert.ok(ULTRA_REVIEW_ERROR_CODES.includes("USAGE"));

// --dry-run reports what it would do and writes nothing.
{
  const dir = workspace();
  const result = run([...baseArgs(dir), "--dry-run"]);
  assert.equal(result.status, 0);
  assert.equal(result.json.dry_run, true);
  assert.equal(existsSync(join(dir, "docs")), false);
  assert.match(result.stdout, /---BEGIN ULTRA REVIEW TEMPLATE---/);
  assert.match(result.stdout, /---END ULTRA REVIEW TEMPLATE---/);
}

// The scaffold must not silently claim a scout count the Lead did not choose:
// a scaled-down run is recorded in the artifact.
{
  const dir = workspace();
  const result = run([
    "--workspace", dir, "--review-name", "small", "--scope", "two files",
    "--review-brief-sha256", SHA, "--scout-count", "4", "--directive-count", "2",
    "--date", "26-08-22",
  ]);
  assert.equal(result.status, 0);
  const written = readFileSync(join(dir, result.json.report_path), "utf8");
  assert.match(written, /Scouts launched: 4/);
  assert.match(written, /Directives: 2/);
}

// --- OCR manifest as the discovery source -----------------------------------

const MANIFEST = {
  schema: "paseo.ocr-review-manifest/v1",
  review: {
    base_sha: "b".repeat(40),
    candidate_sha: "c".repeat(40),
    merge_base_sha: "b".repeat(40),
    candidate_tree_sha: "d".repeat(40),
  },
  harness: { ocr_version: "1.9.9" },
  manifest_digest: "sha256:" + "e".repeat(64),
  reviewable_files: [{ path: "ACP Connector/acp/agent.ts", status: "modified" }],
  excluded_files: [
    { path: "tests/admission.test.ts", status: "modified", exclude_reason: "default_path" },
    { path: "README.md", status: "modified", exclude_reason: "unsupported_ext" },
  ],
  rule_groups: [{ group_id: 1, source: "system", pattern: "**/*.ts", files: ["ACP Connector/acp/agent.ts"], rule: "..." }],
};

function writeManifest(overrides = {}) {
  const dir = workspace();
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ ...MANIFEST, ...overrides }));
  return path;
}

// The whole point of routing OCR into ultra review: scouts get the DISCOVERY
// set, not the selection. Using OCR's selected set here would silently drop
// tests/ and Markdown — precisely where fake-pass proof and stale docs live.
{
  const dir = workspace();
  const result = run([...baseArgs(dir), "--date", "26-08-22", "--ocr-manifest", writeManifest()]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.ocr.discovered_count, 3);
  assert.equal(result.json.ocr.selected_count, 1);
  assert.equal(result.json.ocr.excluded_count, 2);
  assert.equal(result.json.ocr.candidate_sha, "c".repeat(40));
  assert.equal(result.json.ocr.manifest_digest, MANIFEST.manifest_digest);

  const written = readFileSync(join(dir, result.json.report_path), "utf8");
  // Every discovered path must appear, excluded ones included.
  for (const path of ["ACP Connector/acp/agent.ts", "tests/admission.test.ts", "README.md"]) {
    assert.ok(written.includes(path), `report must list discovered file ${path}`);
  }
  assert.match(written, /Discovered \| 3 \(selected 1 \+ excluded 2\)/);
  assert.match(written, /would silently discard\n2 of 3 changed files/);
  assert.match(written, /Base SHA \| `b{40}`/);
  assert.match(written, /DISCOVERED_FILES: 3/);
  assert.match(written, /FILES_UNREACHED:/);
  // Exclusion reasons must survive: a scout deciding how hard to look at a
  // file needs to know OCR dropped it for extension, not for irrelevance.
  assert.ok(written.includes("default_path") && written.includes("unsupported_ext"));
}

// Without a manifest the report carries no OCR section and no false SHA claim.
{
  const dir = workspace();
  const result = run([...baseArgs(dir), "--date", "26-08-22"]);
  assert.equal(result.status, 0);
  assert.equal(result.json.ocr, undefined);
  const written = readFileSync(join(dir, result.json.report_path), "utf8");
  assert.ok(!written.includes("OCR Discovery Set"));
  assert.ok(!written.includes("DISCOVERED_FILES:"));
}

// A manifest that cannot be read or trusted must fail loudly. Silently
// continuing would produce a report that looks SHA-bound but is not.
for (const [args, code, label] of [
  [["--ocr-manifest", join(workspace(), "absent.json")], "OCR_MANIFEST_UNREADABLE", "missing file"],
  [["--ocr-manifest", (() => { const p = join(workspace(), "m.json"); writeFileSync(p, "{not json"); return p; })()], "OCR_MANIFEST_INVALID", "malformed json"],
  [["--ocr-manifest", writeManifest({ schema: "something.else/v9" })], "OCR_MANIFEST_INVALID", "wrong schema"],
  [["--ocr-manifest", writeManifest({ reviewable_files: undefined })], "OCR_MANIFEST_INVALID", "missing reviewable_files"],
  [["--ocr-manifest", writeManifest({ review: { candidate_sha: "c".repeat(40) } })], "OCR_MANIFEST_INVALID", "missing base_sha"],
  [["--ocr-manifest", writeManifest({ manifest_digest: undefined })], "OCR_MANIFEST_INVALID", "missing digest"],
]) {
  const result = run([...baseArgs(workspace()), ...args]);
  assert.equal(result.status, 2, label);
  assert.equal(result.json.code, code, label);
}

// The wrapper's ERROR envelope is valid JSON and would otherwise be consumed as
// a manifest with an empty discovery set — a report claiming zero changed files
// from a preflight that never ran.
{
  const path = join(workspace(), "err.json");
  writeFileSync(path, JSON.stringify({ ok: false, code: "DIRTY_REVIEW_WORKSPACE", message: "…" }));
  const result = run([...baseArgs(workspace()), "--ocr-manifest", path]);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "OCR_MANIFEST_INVALID");
}

// A zero-selection manifest is still a usable discovery set: OCR selecting
// nothing (a docs-only commit) must not read as "nothing changed".
{
  const dir = workspace();
  const path = writeManifest({
    reviewable_files: [],
    excluded_files: [{ path: "README.md", status: "modified", exclude_reason: "unsupported_ext" }],
    rule_groups: [],
  });
  const result = run([...baseArgs(dir), "--date", "26-08-22", "--ocr-manifest", path]);
  assert.equal(result.status, 0);
  assert.equal(result.json.ocr.discovered_count, 1);
  const written = readFileSync(join(dir, result.json.report_path), "utf8");
  assert.match(written, /\| _none_ \| selected \|/);
  assert.ok(written.includes("README.md"));
}

// --- template ---------------------------------------------------------------

{
  const text = markdownTemplate({
    dateSlug: "26-08-22",
    reviewName: "demo",
    roundNumber: 1,
    scope: "scope text",
    reportPath: "docs/ultrareview/26-08-22-demo-round-1.md",
    priorReports: [],
    reviewBriefSha256: SHA,
    scoutCount: 10,
    directiveCount: 3,
  });
  assert.match(text, /Previous reports read:\n- none/);
  // Upstream shipped these sections and the skill explicitly forbids them; the
  // template must not reintroduce clutter the consuming agent has to skip.
  for (const forbidden of ["Raw Candidate Ledger", "Execution Receipt", "Merge Notes"]) {
    assert.ok(!text.includes(forbidden), `template must not contain ${forbidden}`);
  }
}

console.log("ultra-review-report tests passed");

// ---------------------------------------------------------------------------
// Convergence gate — fix-eligible requires reproduction AND (convergence ≥ k
// OR contract-breaker). The gate exists so a review never fixes on one
// scout's plausible story (round-1: 3 of 12 fixes landed below this bar).
// ---------------------------------------------------------------------------

assert.equal(findingAction({ convergence: 7, reproduced: true }), "fix-eligible");
assert.equal(findingAction({ convergence: 3, reproduced: true }), "fix-eligible");
assert.equal(findingAction({ convergence: 2, reproduced: true }), "record-only");
assert.equal(findingAction({ convergence: 1, reproduced: true, contractBreaker: true }), "fix-eligible");
// Reproduction is non-negotiable — convergence alone never fixes.
assert.equal(findingAction({ convergence: 10, reproduced: false }), "record-only");
assert.equal(findingAction({ convergence: 10 }), "record-only");
assert.equal(findingAction({ convergence: 10, reproduced: "yes" }), "record-only");
// Fail-closed on malformed shapes.
assert.equal(findingAction({}), "record-only");
assert.equal(findingAction({ convergence: NaN, reproduced: true }), "record-only");
assert.equal(findingAction(), "record-only");

// The scaffold carries the gate columns so a consolidator cannot omit them.
let templateMd;
{
  templateMd = markdownTemplate({
    dateSlug: "26-08-31", reviewName: "x", roundNumber: 1, scope: "s",
    reportPath: "docs/ultrareview/x.md", priorReports: [], reviewBriefSha256: "a".repeat(64),
    scoutCount: 10, directiveCount: 0, manifest: null,
  });
  assert.match(templateMd, /^Gate: v1$/m);
  assert.match(templateMd, /Convergence: TODO n\/10 \| Reproduced: TODO yes\/no \| Contract-breaker: TODO yes\/no \| Action: TODO/);
  assert.match(templateMd, /CONVERGENCE GATE \(mandatory on every finding/);
  assert.match(templateMd, /architect-Peer on the root question before fixing/);
  // Trade-off is the second half of the gate: convergence answers "is it
  // real", trade-off answers "is fixing it now a good exchange". The template
  // must force the statement so a fix-eligible finding cannot be applied with
  // the question silently skipped (round-1 F017 was exactly that).
  assert.match(templateMd, /Trade-off of fixing now:/);
  assert.match(templateMd, /TRADE-OFF \(second half of the gate\)/);
  assert.match(templateMd, /"none identified" written out, never implied/);
}

console.log("convergence gate tests passed");

// ---------------------------------------------------------------------------
// GATE_FIELDS / parseGateLine — the exact per-finding grammar. Fail-closed:
// TODO, missing, or an unchosen template token is `unknown` plus an anomaly,
// never a silently accepted guess.
// ---------------------------------------------------------------------------

assert.deepEqual([...GATE_FIELDS.reproduced], ["yes", "no", "partial"]);
assert.deepEqual([...GATE_FIELDS.contractBreaker], ["yes", "no"]);
assert.deepEqual([...GATE_FIELDS.action], ["fix-eligible", "record-only"]);

{
  const gate = parseGateLine(
    "Convergence: 3/8 | Reproduced: yes (repro command) | Contract-breaker: no | Action: fix-eligible",
    "F001",
  );
  assert.deepEqual(gate, {
    convergence: 3, planned: 8, reproduced: "yes", contractBreaker: "no", action: "fix-eligible", anomalies: [],
  });
}

// KILLING TEST: the unchosen template choice text "fix-eligible/record-only"
// (a plausible human slip: copying the whole "pick one" placeholder instead
// of choosing) must never parse as the chosen "fix-eligible" — the F006 bug
// was exactly a prefix match (the old regex's [A-Za-z-]+ char class stops at
// "/", capturing "fix-eligible" as if it were the whole, chosen value).
// Mutate line: matchToken's regex from
// `^${escapeRegExp(token)}\\s*(\\(.*\\))?$` to `^${escapeRegExp(token)}` (drop
// the `$` end-anchor) and this assertion fails — the prefix "fix-eligible"
// matches again.
{
  const gate = parseGateLine(
    "Convergence: 5/10 | Reproduced: yes | Contract-breaker: no | Action: fix-eligible/record-only",
    "F001",
  );
  assert.equal(gate.action, "unknown");
  assert.ok(gate.anomalies.some((a) => a.includes('Action value "fix-eligible/record-only" is unknown')));
  assert.equal(gate.convergence, 5);
  assert.equal(gate.reproduced, "yes");
  assert.equal(gate.contractBreaker, "no");
}

// The template's own real placeholder ("TODO fix-eligible/record-only") is a
// different, simpler failure mode — TODO-prefixed and unfilled — also unknown.
{
  const gate = parseGateLine(
    "Convergence: TODO n/10 | Reproduced: TODO yes/no | Contract-breaker: TODO yes/no | Action: TODO fix-eligible/record-only",
    "F001",
  );
  assert.equal(gate.action, "unknown");
  assert.ok(gate.anomalies.some((a) => a.includes('Action value "TODO fix-eligible/record-only" is unknown')));
  assert.equal(gate.convergence, null);
  assert.equal(gate.reproduced, "unknown");
  assert.equal(gate.contractBreaker, "unknown");
}

// A gate line missing entirely is one anomaly, not a silent all-unknown pass.
{
  const gate = parseGateLine("Severity: P1 | Confidence: high\nno gate line here", "F002");
  assert.equal(gate.action, "unknown");
  assert.equal(gate.anomalies.length, 1);
  assert.match(gate.anomalies[0], /no gate line/);
}

console.log("parseGateLine tests passed");

// ---------------------------------------------------------------------------
// parseReport — pre-gate declaration (item b). A report without Gate: v1 is
// declared pre-gate: ONE anomaly for the whole file, findings not
// decision-bearing, never inferred finding-by-finding from missing Action
// lines.
// ---------------------------------------------------------------------------

{
  const preGateText = [
    "# Ultra Review: demo Round 1",
    "",
    "### F001 x",
    "Convergence: 3/8 | Reproduced: yes | Action: fix-eligible",
    "### F002 y",
    "Convergence: 1/8 | Reproduced: no | Action: record-only",
  ].join("\n");
  const parsed = parseReport(preGateText);
  assert.equal(parsed.preGate, true);
  assert.deepEqual(parsed.findings, []);
  assert.deepEqual(parsed.scoutsMissing, []);
  assert.equal(parsed.anomalies.length, 1);
  assert.match(parsed.anomalies[0], /pre-gate report \(no "Gate: v1" marker\) — 2 finding\(s\) declared not decision-bearing/);

  const checked = checkReportGate(preGateText);
  assert.deepEqual(checked, parsed);
}

console.log("pre-gate declaration tests passed");

// ---------------------------------------------------------------------------
// checkReportGate — killing tests from the architect ruling (E2).
// ---------------------------------------------------------------------------

const gated = (...findingBlocks) =>
  [
    "# Ultra Review: demo Round 1",
    "",
    GATE_MARKER_LINE,
    "",
    "## Findings",
    "",
    ...findingBlocks,
    "## Coverage And Limits",
    "",
    "SCOUTS_MISSING: 0",
    "",
  ].join("\n");

// KILLING TEST: round-trip parseReport(markdownTemplate(...)) — the freshly
// scaffolded template (all TODO placeholders) must parse as all-unknown with
// the EXACT anomaly set, never as a silently-accepted decision. This is THE
// drift mechanism the ruling targets: an unfilled template must never read as
// a completed one. Mutate line: the F001 gate-line placeholder in
// markdownTemplate from "Contract-breaker: TODO yes/no" to
// "Contract-breaker: no" and the Contract-breaker anomaly below disappears.
{
  const parsed = checkReportGate(templateMd);
  assert.equal(parsed.preGate, false);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].action, "unknown");
  assert.deepEqual(
    [...parsed.anomalies].sort(),
    [
      "F001: Action value \"TODO fix-eligible/record-only\" is unknown",
      "F001: Contract-breaker value \"TODO yes/no\" is unknown",
      "F001: Convergence value \"TODO n/10\" is not n/m",
      "F001: Reproduced value \"TODO yes/no\" is unknown",
      "SCOUTS_MISSING is unfilled — scout coverage cannot be verified",
    ].sort(),
  );
}

// KILLING TEST: "(not applied)" must never parse as applied — the F006
// fail-open bug was a substring scan (/\bapplied\b/i) matching "applied"
// inside "not applied". There is no dedicated "Applied:" line here, so the
// result must be applied=false with no anomaly (prose is not grammar).
// Mutate line: parseReport's `appliedMatch` block — replace the dedicated
// `^[ \t]*Applied:\s*([^\n]*)$` line-anchor with a bare `/applied/i` substring
// test, and this assertion flips to true.
{
  const text = gated(
    "### F001 legacy note",
    "Convergence: 5/10 | Reproduced: yes | Contract-breaker: no | Action: record-only",
    "Trade-off of fixing now:",
    "- none identified",
    "Note: shipped previously (not applied) due to a missing prerequisite.",
    "",
  );
  const { findings, anomalies } = checkReportGate(text);
  assert.equal(findings[0].applied, false);
  assert.ok(!anomalies.some((a) => a.includes("Applied")));
}

// A dedicated Applied: yes line is the only way to mark a finding applied.
{
  const text = gated(
    "### F001 applied via dedicated line",
    "Convergence: 5/10 | Reproduced: yes | Contract-breaker: no | Action: record-only",
    "Applied: yes",
    "",
    "## Applied fixes",
    "",
    "| Finding | Fix |",
    "|---|---|",
    "| F002 | table-agnostic row must NOT mark F001 applied |",
    "",
  );
  const { findings } = checkReportGate(text);
  assert.equal(findings[0].applied, true);
}

// KILLING TEST: seeded below-gate fix-eligible -> disagreement anomaly. A
// hand-written "fix-eligible" that the gate math computes as "record-only"
// (Convergence 1 < 3, no contract-breaker) is downgraded to the computed
// value, and the disagreement is reported rather than silently accepted —
// this is the exact round-1 failure mode (3 of 12 fixes below the bar).
{
  const text = gated(
    "### F003 below the bar",
    "Convergence: 1/10 | Reproduced: yes | Contract-breaker: no | Action: fix-eligible",
    "",
  );
  const { findings, anomalies } = checkReportGate(text);
  assert.equal(findings[0].action, "record-only");
  assert.ok(anomalies.some((a) => a.includes('F003: Action "fix-eligible" disagrees with computed "record-only"')));
}

// Trade-off is required on a (computed) fix-eligible finding, else an anomaly.
{
  const text = gated(
    "### F004 no trade-off",
    "Convergence: 4/10 | Reproduced: yes | Contract-breaker: no | Action: fix-eligible",
    "",
  );
  const { findings, anomalies } = checkReportGate(text);
  assert.equal(findings[0].action, "fix-eligible");
  assert.ok(anomalies.some((a) => a.includes('F004: fix-eligible with no "Trade-off of fixing now" statement')));
}

console.log("checkReportGate killing tests passed");
