// ultra-review-report.test.mjs — artifact contract for the ultra-review scaffold.
// Run: node test/ultra-review-report.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ULTRA_REVIEW_ERROR_CODES,
  markdownTemplate,
  nextRound,
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
