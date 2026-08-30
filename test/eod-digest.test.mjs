// eod-digest.test.mjs — contract for the deterministic Tier-1 EOD digest.
// Run: node test/eod-digest.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EOD_DIGEST_ERROR_CODES,
  MAX_COMMIT_SUBJECTS,
  MAX_DIGEST_LINES,
  buildDigest,
  parseNotebookRecords,
} from "../scripts/eod-digest.mjs";
import { GATE_MARKER_LINE } from "../scripts/ultra-review-report.mjs";
import { policyDigest } from "../scripts/policy-digest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "eod-digest.mjs");
const NODE = process.execPath;
const DATE = "26-07-15"; // deliberately not today, so date filtering is proven, not accidental

function run(args) {
  const result = spawnSync(NODE, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, timeout: 30_000 });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { ...result, json };
}

const workspace = () => mkdtempSync(join(tmpdir(), "paseo-eod-digest-"));

function git(cwd, args, dateIso) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}),
  };
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function initRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
}

function commit(dir, subject, dateIso) {
  git(dir, ["commit", "-q", "--allow-empty", "-m", subject], dateIso);
}

const REPORT = [
  "# Ultra Review: demo Round 1",
  "",
  `Date: ${DATE}`,
  "",
  GATE_MARKER_LINE,
  "",
  "## Findings",
  "",
  "### F001 [P1] preflight swallows flag",
  "",
  "Severity: P1 | Confidence: high",
  "Convergence: 4/10 | Reproduced: yes | Contract-breaker: no | Action: fix-eligible",
  "Source pointer: scripts/preflight.mjs:58",
  "Trade-off of fixing now:",
  "- none identified",
  "",
  "### F002 [P3] cosmetic drift",
  "",
  "Convergence: 1/10 | Reproduced: no | Contract-breaker: no | Action: record-only",
  "",
  "### F003 [P2] applied via the dedicated line",
  "",
  "Convergence: 5/10 | Reproduced: yes | Contract-breaker: no | Action: fix-eligible",
  "Applied: yes",
  "Trade-off of fixing now:",
  "- none identified",
  "",
  "### F004 [P2] applied via the dedicated line; table row below is decorative only",
  "",
  "Convergence: 3/10 | Reproduced: yes | Contract-breaker: no | Action: fix-eligible",
  "Applied: yes",
  "Trade-off of fixing now:",
  "- none identified",
  "",
  "## Applied fixes",
  "",
  "| Finding | Fix |",
  "|---|---|",
  "| F004 | did the thing |",
  "",
  "## Coverage And Limits",
  "",
  "SCOUTS_PLANNED: 10",
  "SCOUTS_SUBMITTED: 10",
  "SCOUTS_MISSING: 0",
  "",
].join("\n");

const NOTEBOOK = [
  "# Supervisor Notebook",
  "",
  "## Records",
  "",
  "### N-001 — create_agent flapped",
  "```text",
  "Pattern / episode: create_agent failed twice",
  `Scope + date: proj · ws · 20${DATE} 14:02`,
  "Escalation needed: no",
  "```",
  "",
  "### N-002 — policy drift needs a call",
  "```text",
  `Scope + date: proj · ws · 20${DATE} 15:00`,
  "Escalation needed: Human must approve digest refresh",
  "```",
  "",
  "### N-003 — different day, must be filtered out",
  "```text",
  "Scope + date: proj · ws · 2026-07-14 09:00",
  "Escalation needed: yes, big decision",
  "```",
  "",
].join("\n");

/** Writes a manifest.json whose policyDigest is the REAL computed digest over
 * `dir` (which has no governed dirs, so this is the "zero governed files"
 * digest) — so buildDigest's recorded-vs-computed check matches by
 * construction instead of drifting whenever policyDigest()'s algorithm
 * changes. Returns the manifest object so tests can assert against the
 * actual values rather than a hardcoded stand-in. */
function writeManifest(dir, overrides = {}) {
  const computed = policyDigest(dir);
  const manifest = {
    schema: "paseo.team-policy-digest/v1",
    policyDigest: computed.policyDigest,
    fileCount: computed.fileCount,
    files: {},
    ...overrides,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

/** Full fixture: dated report + notebook + manifest + real git repo. */
function fullWorkspace() {
  const dir = workspace();
  mkdirSync(join(dir, "docs", "ultrareview"), { recursive: true });
  writeFileSync(join(dir, "docs", "ultrareview", `${DATE}-demo-round-1.md`), REPORT);
  // A report dated another day must not be scanned.
  writeFileSync(join(dir, "docs", "ultrareview", "26-07-14-old-round-1.md"), REPORT);
  writeFileSync(join(dir, "docs", "supervisor-notebook.md"), NOTEBOOK);
  const manifest = writeManifest(dir);
  initRepo(dir);
  commit(dir, "day-before commit must be filtered", "2026-07-14T18:00:00");
  commit(dir, "fix: close the preflight hole", `20${DATE}T10:00:00`);
  commit(dir, "docs: refresh runbook", `20${DATE}T11:30:00`);
  return { dir, manifest };
}

// Report-grammar parsing (finding blocks, gate-line tokens, SCOUTS_MISSING,
// Applied/Trade-off lines, pre-gate declaration) has ONE owner now —
// scripts/ultra-review-report.mjs (GATE_FIELDS, parseGateLine, parseReport,
// checkReportGate) — and its tests live in test/ultra-review-report.test.mjs.
// This file only exercises eod-digest's OWN concerns: notebook/manifest/git
// gathering, digest assembly, and the CLI, calling into checkReportGate as a
// consumer rather than re-testing its internals.

// --- parseNotebookRecords -----------------------------------------------------

{
  const records = parseNotebookRecords(NOTEBOOK, DATE);
  assert.equal(records.length, 2); // N-003 is another day
  assert.equal(records[0].needsDecision, false);
  assert.equal(records[1].needsDecision, true);
  assert.match(records[1].reason, /Human must approve digest refresh/);
}

// Fail-closed: unfilled or missing Escalation field is a decision item.
{
  const text = [
    "### N-009 — unfilled escalation",
    `Scope + date: p · w · 20${DATE} 09:00`,
    "Escalation needed:",
    "",
    "### N-010 — field missing entirely",
    `Scope + date: p · w · ${DATE} 10:00`, // short-form date must also match
    "Outcome: resolved",
  ].join("\n");
  const records = parseNotebookRecords(text, DATE);
  assert.equal(records.length, 2);
  assert.equal(records[0].needsDecision, true);
  assert.match(records[0].reason, /unfilled/);
  assert.equal(records[1].needsDecision, true);
  assert.match(records[1].reason, /field missing/);
}

// Blocks without a "Scope + date" line (template record-shape) are not records.
assert.deepEqual(parseNotebookRecords("### N-001 — shape only\nEscalation needed: no\n", DATE), []);
assert.throws(() => parseNotebookRecords("x", "2026-07-15"), (e) => e.code === "USAGE");

// --- buildDigest (pure) -------------------------------------------------------

// The digest line cap keeps the footer and plants an explicit marker.
{
  const files = [
    {
      name: "big.md",
      findings: Array.from({ length: 300 }, (_, i) => ({
        id: `F${String(i + 1).padStart(3, "0")}`,
        title: "t",
        action: "fix-eligible",
        applied: false,
        reason: null,
      })),
      scoutsMissing: [],
      anomalies: [],
    },
  ];
  const { markdown, metadata } = buildDigest({
    date: DATE,
    reports: { status: "scanned", files },
    notebook: { status: "missing", reason: "absent", records: [] },
    manifest: { status: "missing", reason: "absent" },
    git: { status: "missing", reason: "not a repo", totalCommits: 0, subjects: [], truncated: false },
  });
  const lines = markdown.trimEnd().split("\n");
  assert.ok(lines.length <= MAX_DIGEST_LINES, `digest is ${lines.length} lines`);
  assert.equal(metadata.truncation.digest_lines, true);
  assert.match(markdown, /… digest truncated: \d+ body line\(s\) omitted/);
  assert.match(markdown, /## Accounting/); // footer survives the cap
  assert.match(markdown, new RegExp(`digest capped at ${MAX_DIGEST_LINES} lines`));
  assert.equal(metadata.counts.decisions, 300); // precomputed total, not the capped view
}

assert.throws(() => buildDigest({ date: "bogus" }), (e) => e.code === "USAGE");

// --- CLI: flag validation fails closed ----------------------------------------

for (const [args, label] of [
  [["--workspace", ROOT, "--bogus"], "unknown flag"],
  [["--workspace", ROOT, "--bogus", "x"], "unknown flag with value"],
  [["--date", DATE], "missing workspace"],
  [["--workspace"], "workspace without value"],
  [["--workspace", ROOT, "--date", "2026-07-15"], "wrong date format"],
  // KILLING TEST (item i): --date round-trips through Date — "26-99-99"
  // matches the yy-mm-dd shape but is not a calendar date. Mutate line:
  // isValidDateSlug's Date.UTC round-trip check back to a bare
  // DATE_SLUG.test(value) and these two start passing through as valid.
  [["--workspace", ROOT, "--date", "26-99-99"], "impossible month and day"],
  [["--workspace", ROOT, "--date", "26-02-30"], "February 30th does not exist"],
]) {
  const result = run(args);
  assert.equal(result.status, 2, label);
  assert.equal(result.json.ok, false, label);
  assert.equal(result.json.code, "USAGE", label);
}

{
  const result = run(["--workspace", join(workspace(), "nope"), "--date", DATE]);
  assert.equal(result.status, 2);
  assert.equal(result.json.code, "WORKSPACE_MISSING");
}

assert.ok(EOD_DIGEST_ERROR_CODES.includes("USAGE"));
assert.ok(EOD_DIGEST_ERROR_CODES.includes("WORKSPACE_MISSING"));

// --- CLI: an all-missing workspace is NOT a confirmed quiet day (U8) ----------

// KILLING TEST (item g): quiet_day requires ALL FOUR sources to have actually
// been scanned. A workspace where every source is merely MISSING (never
// checked) must not read as "checked, found nothing" — that was the U8 bug
// (quiet_day:true when all sources missing). Mutate line: buildDigest's
// `const quietDay = allScanned && body.length === 0;` back to
// `body.length === 0` and this test's first two assertions fail.
{
  const dir = workspace(); // nothing in it: no docs, no manifest, not a git repo
  const result = run(["--workspace", dir, "--date", DATE, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.quiet_day, false, "all sources missing must never be a confirmed quiet day");

  const plain = run(["--workspace", dir, "--date", DATE]);
  assert.ok(!plain.stdout.includes("Quiet day — no decisions needed"), "must not claim a quiet day it never scanned");
  assert.match(plain.stdout, /Cannot confirm a quiet day — 4 of 4 source\(s\) not scanned/);
  assert.match(plain.stdout, /## Accounting/);
  // Still no padded sections — the "cannot confirm" line is the whole body.
  for (const section of ["## Decisions needed", "## Anomalies", "## Applied changes", "## Review activity"]) {
    assert.ok(!plain.stdout.includes(section), `all-missing digest must omit "${section}"`);
  }
  // Every missing source is REPORTED, not silently skipped.
  assert.match(plain.stdout, /sources scanned 0\/4 · missing 4/);
  assert.match(plain.stdout, /docs\/ultrareview\/: missing/);
  assert.match(plain.stdout, /docs\/supervisor-notebook\.md: missing/);
  assert.match(plain.stdout, /manifest\.json: missing/);
  assert.match(plain.stdout, /git log: missing — workspace is not a git repository/);
  assert.match(plain.stdout, /Policy digest: unavailable — manifest\.json missing/);
  assert.ok(plain.stdout.trimEnd().split("\n").length < 25, "all-missing digest must stay short");
}

// --- CLI: full day — decisions, sections, ordering, date filtering -------------

{
  const { dir, manifest } = fullWorkspace();
  const result = run(["--workspace", dir, "--date", DATE]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = result.stdout;

  // Fix-eligible-not-applied surfaces; record-only and applied ones do not.
  assert.match(out, /## Decisions needed/);
  assert.match(out, /F001 — fix-eligible, not marked applied/);
  assert.ok(!out.includes("F002 —"), "record-only finding must not be a decision");
  assert.ok(!out.includes("F003 —"), "dedicated-Applied-line finding must not be a decision");
  assert.ok(!out.includes("F004 —"), "dedicated-Applied-line finding must not be a decision");

  // Notebook: only the open escalation, only for this date.
  assert.match(out, /N-002 — policy drift needs a call — Escalation needed: Human must approve digest refresh/);
  assert.ok(!out.includes("N-001 —"), "Escalation needed: no must not be a decision");
  assert.ok(!out.includes("N-003"), "other-day record must be filtered out");

  // Git: only same-day commits, newest first.
  assert.match(out, /## Applied changes/);
  assert.match(out, /- docs: refresh runbook/);
  assert.match(out, /- fix: close the preflight hole/);
  assert.ok(!out.includes("day-before commit must be filtered"));

  // Review activity is counts only, and only the dated report is scanned.
  assert.match(out, /## Review activity/);
  assert.match(out, new RegExp(`Ultra-review reports dated ${DATE}: 1 · findings 4 \\(fix-eligible 3 · record-only 1 · unverifiable 0\\)`));
  assert.match(out, new RegExp(`Notebook records dated ${DATE}: 2 \\(open escalations 1\\)`));
  assert.ok(!out.includes("26-07-14-old-round-1.md"), "other-day report must not be scanned");

  // Attribution footer: the recorded digest is verified against computed
  // bytes, not just echoed — this fixture's manifest was written from the
  // real computed digest, so it must match cleanly (no MISMATCH).
  assert.match(out, new RegExp(`Policy digest: ${manifest.policyDigest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(fileCount ${manifest.fileCount}\\)`));
  assert.ok(!out.includes("MISMATCH"), "a freshly computed manifest must not report a digest mismatch");
  assert.match(out, /- Truncation: none/);

  // Section order is fixed.
  const order = ["## Decisions needed", "## Anomalies", "## Applied changes", "## Review activity", "## Accounting"]
    .map((section) => out.indexOf(section));
  assert.equal(order[1], -1, "no anomalies in this fixture");
  const present = order.filter((index) => index !== -1);
  assert.deepEqual([...present].sort((a, b) => a - b), present, "sections must appear in the fixed order");
}

// --- CLI: anomalies — SCOUTS_MISSING and malformed manifest --------------------

{
  const dir = workspace();
  mkdirSync(join(dir, "docs", "ultrareview"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "ultrareview", `${DATE}-anomaly-round-1.md`),
    `${GATE_MARKER_LINE}\n### F001 x\nConvergence: 1/10 | Reproduced: no | Contract-breaker: no | Action: record-only\nSCOUTS_MISSING: scout-03, scout-08\n`,
  );
  writeFileSync(join(dir, "manifest.json"), "{not json");
  const result = run(["--workspace", dir, "--date", DATE]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /## Anomalies/);
  assert.match(result.stdout, /SCOUTS_MISSING: scout-03, scout-08/);
  assert.match(result.stdout, /\[manifest\.json\] manifest\.json is not valid JSON/);
  assert.match(result.stdout, /malformed\/failed\/broken 1/);
  assert.match(result.stdout, /Policy digest: unavailable — manifest\.json malformed/);
}

// --- CLI: manifest digest mismatch is verified, not just echoed (item h) ------

// KILLING TEST: a manifest.json whose recorded policyDigest does not match
// the computed digest over current governed bytes must surface as an
// anomaly, never be silently echoed as attribution. Mutate line: the
// mismatch guard in buildDigest (`manifest.computedPolicyDigest &&
// manifest.computedPolicyDigest !== manifest.policyDigest`) — drop the
// inequality check — and this anomaly disappears.
{
  const dir = workspace();
  writeManifest(dir, { policyDigest: "sha256:" + "0".repeat(64) });
  const result = run(["--workspace", dir, "--date", DATE]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /## Anomalies/);
  assert.match(result.stdout, /policyDigest sha256:0{64} does not match computed sha256:[0-9a-f]{64}/);
  assert.match(result.stdout, /Policy digest: sha256:0{64} recorded vs sha256:[0-9a-f]{64} computed — MISMATCH/);
}

// --- CLI: commit-subject truncation is signalled, never a silent total ---------

{
  const dir = workspace();
  initRepo(dir);
  for (let i = 1; i <= MAX_COMMIT_SUBJECTS + 5; i++) {
    commit(dir, `commit ${String(i).padStart(2, "0")}`, `20${DATE}T08:${String(i).padStart(2, "0")}:00`);
  }
  const result = run(["--workspace", dir, "--date", DATE, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.schema, "paseo.eod-digest/v1");
  assert.equal(result.json.counts.commits_total, MAX_COMMIT_SUBJECTS + 5);
  assert.equal(result.json.counts.commits_shown, MAX_COMMIT_SUBJECTS);
  assert.equal(result.json.truncation.commit_subjects, true);

  const plain = run(["--workspace", dir, "--date", DATE]);
  assert.match(plain.stdout, /… 5 more commit\(s\) not shown \(25 total; subjects capped at 20\)/);
  assert.match(plain.stdout, /Truncation: commit subjects capped at 20 of 25/);
}

// --- CLI: --out writes the digest; --dry-run does not --------------------------

{
  const { dir, manifest } = fullWorkspace();
  const outPath = join(dir, "reports", "digest.md");

  const dry = run(["--workspace", dir, "--date", DATE, "--out", outPath, "--dry-run", "--json"]);
  assert.equal(dry.status, 0);
  assert.equal(dry.json.dry_run, true);
  assert.equal(existsSync(outPath), false, "--dry-run must not write");

  const wet = run(["--workspace", dir, "--date", DATE, "--out", outPath, "--json"]);
  assert.equal(wet.status, 0);
  assert.equal(wet.json.dry_run, false);
  assert.equal(wet.json.out, outPath);
  const written = readFileSync(outPath, "utf8");
  assert.match(written, new RegExp(`# EOD Digest — ${DATE}`));
  assert.match(written, /## Accounting/);
  // The --json envelope is metadata, deterministic and self-accounting.
  assert.equal(wet.json.quiet_day, false);
  assert.equal(wet.json.counts.decisions, 2);
  assert.equal(wet.json.policy_digest, manifest.policyDigest);
  assert.equal(wet.json.file_count, manifest.fileCount);
  assert.equal(wet.json.sources.notebook.status, "scanned");
  assert.equal(wet.json.sources.git.status, "scanned");
}

console.log("eod-digest tests passed");
