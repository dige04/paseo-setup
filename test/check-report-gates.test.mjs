// check-report-gates.test.mjs — proof of life for the gate's second caller.
// Run: node test/check-report-gates.test.mjs
//
// This test exists because the reviewer's mutation probe M12 inverted the
// exit wiring of the previous INLINE CI gate script and the whole suite
// stayed green (pack-ship fix-cycle R1). Every branch here crosses a real
// process boundary: a gated report with a seeded gate disagreement must turn
// into a nonzero EXIT CODE, not just an anomaly string in memory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReportsDir } from "../scripts/check-report-gates.mjs";
import { GATE_MARKER_LINE } from "../scripts/ultra-review-report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-report-gates.mjs");
const NODE = process.execPath;

const run = (args) => spawnSync(NODE, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });

const GATED_CLEAN = [
	"# Ultra Review: demo Round 9",
	"",
	GATE_MARKER_LINE,
	"",
	"### F001 [P1] demo finding",
	"Convergence: 4/8 | Reproduced: yes | Contract-breaker: no | Action: fix-eligible",
	"Applied: no",
	"Trade-off of fixing now:",
	"- none identified",
	"",
	"SCOUTS_MISSING: none",
	"",
].join("\n");

// Same report with the gate inputs weakened below the bar while the
// hand-written Action still claims fix-eligible — the exact disagreement
// checkReportGate() exists to catch.
const GATED_BELOW_BAR = GATED_CLEAN.replace(
	"Convergence: 4/8 | Reproduced: yes",
	"Convergence: 1/8 | Reproduced: no",
);

const PRE_GATE = "# Ultra Review: legacy Round 1\n\n### F001 old finding\nno gate fields here\n";

// --- pure function ------------------------------------------------------------

{
	const dir = mkdtempSync(join(tmpdir(), "gate-check-"));
	writeFileSync(join(dir, "a-clean.md"), GATED_CLEAN);
	writeFileSync(join(dir, "b-legacy.md"), PRE_GATE);
	writeFileSync(join(dir, "notes.txt"), "not a report");
	const result = checkReportsDir(dir);
	assert.equal(result.gated, 1);
	assert.equal(result.preGate, 1);
	assert.equal(result.failed, 0);
}

// --- process boundary: clean dir exits 0 --------------------------------------

{
	const dir = mkdtempSync(join(tmpdir(), "gate-check-clean-"));
	writeFileSync(join(dir, "a-clean.md"), GATED_CLEAN);
	writeFileSync(join(dir, "b-legacy.md"), PRE_GATE);
	const result = run([dir]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /clean: a-clean\.md/);
	assert.match(result.stdout, /pre-gate: b-legacy\.md/);
	assert.match(result.stdout, /gated=1 pregate=1 failed=0/);
}

// --- process boundary: a below-bar gated report exits 1 -----------------------
// This is the branch mutation probe M12 proved the inline CI script could
// lose silently. Here it is load-bearing: exit code, not log text.

{
	const dir = mkdtempSync(join(tmpdir(), "gate-check-bad-"));
	writeFileSync(join(dir, "a-below-bar.md"), GATED_BELOW_BAR);
	const result = run([dir]);
	assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}`);
	assert.match(result.stderr, /GATE: a-below-bar\.md/);
	assert.match(result.stderr, /disagrees with computed/);
}

// A pre-gate-only directory is not a failure — declared legacies pass.
{
	const dir = mkdtempSync(join(tmpdir(), "gate-check-legacy-"));
	writeFileSync(join(dir, "legacy.md"), PRE_GATE);
	const result = run([dir]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /gated=0 pregate=1 failed=0/);
}

// --- usage errors --------------------------------------------------------------

{
	const missing = join(mkdtempSync(join(tmpdir(), "gate-check-miss-")), "nope");
	const result = run([missing]);
	assert.equal(result.status, 2);
	assert.equal(JSON.parse(result.stdout).code, "DIR_MISSING");

	const flags = run(["--bogus"]);
	assert.equal(flags.status, 2);
	assert.equal(JSON.parse(flags.stdout).code, "USAGE");
}

// --- the repo's own reports must pass the gate the way CI will run it ---------

{
	const result = run([join(ROOT, "docs", "ultrareview")]);
	assert.equal(result.status, 0, `repo's own reports fail the gate: ${result.stderr}`);
}

console.log("check-report-gates tests passed");
