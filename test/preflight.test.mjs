// preflight.test.mjs — behavioral evidence for the readiness surface.
// Run: node test/preflight.test.mjs
//
// Bench cycle 1, finding preflight-no-behavior-test: ~865 lines protected only
// by `node --check` plus two probes hosted in policy-digest.test.mjs — the CI
// comment admitted it in writing. Every assert here crosses the real process
// boundary; a logic regression (not just a parse error) must fail the suite.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "preflight.mjs");
const NODE = process.execPath;

const run = (args) => spawnSync(NODE, [SCRIPT, ...args], { encoding: "utf8", timeout: 60_000, cwd: ROOT });

// Error envelopes currently go to stderr ({ok:false, error:...}) — the
// envelope-convention split is recorded (pack-ship F012, record-only); this
// parser tolerates either stream so THESE asserts pin behavior, not the
// stream choice, and keep biting if F012 is later unified.
const envelopeOf = (result) => {
	for (const stream of [result.stderr, result.stdout]) {
		for (const line of String(stream ?? "").split("\n")) {
			const text = line.trim();
			if (!text.startsWith("{")) continue;
			try {
				const parsed = JSON.parse(text);
				if (parsed && parsed.ok === false) return parsed;
			} catch {
				/* not this line */
			}
		}
	}
	return null;
};

// --- --version: the attribution ritual ---------------------------------------
// Every artifact cites this output; its shape is a machine contract.
{
	const result = run(["--version"]);
	assert.equal(result.status, 0, result.stderr);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.name, "paseo-claude-team");
	assert.match(String(parsed.version), /^\d+\.\d+\.\d+$/);
	assert.match(parsed.policyDigest, /^sha256:[a-f0-9]{64}$/);
	assert.ok(Number.isInteger(parsed.fileCount) && parsed.fileCount > 0);
}

// --version output must agree with the digest module itself — the ritual is
// worthless if it prints a number nothing else computes.
{
	const digest = spawnSync(NODE, [join(ROOT, "scripts", "policy-digest.mjs"), "--json"], { encoding: "utf8", timeout: 60_000 });
	const fromVersion = JSON.parse(run(["--version"]).stdout);
	const fromDigest = JSON.parse(digest.stdout);
	assert.equal(fromVersion.policyDigest, fromDigest.policyDigest, "--version and policy-digest disagree on the digest");
}

// --- unknown flag: refuse loudly, name the known set -------------------------
{
	const result = run(["--bogus-flag"]);
	assert.equal(result.status, 2, "unknown flag must exit 2, never run");
	const envelope = envelopeOf(result);
	assert.ok(envelope, "unknown flag must emit a structured envelope");
	assert.equal(envelope.error, "unknown_flag");
	assert.ok(Array.isArray(envelope.known) && envelope.known.includes("--version"), "the envelope must list the known flags");
}

// The near-miss typo class that motivated the strict scan (--stict episode).
{
	const result = run(["--stric"]);
	assert.equal(result.status, 2);
	assert.equal(envelopeOf(result)?.error, "unknown_flag");
}

// --- value flags: a missing value is a refusal, not a swallowed token --------
{
	const result = run(["--host-id"]);
	assert.equal(result.status, 2, "a value flag with no value must exit 2");
	assert.equal(envelopeOf(result)?.error, "missing_flag_value");
	assert.equal(envelopeOf(result)?.flag, "--host-id");
}

// A value that is actually the NEXT flag must also refuse — silently eating
// "--cluster --version" as value would run the wrong command shape.
{
	const result = run(["--cluster", "--version"]);
	assert.equal(result.status, 2);
	assert.equal(envelopeOf(result)?.error, "missing_flag_value");
}

console.log("preflight tests passed");
