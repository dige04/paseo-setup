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
