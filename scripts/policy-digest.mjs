#!/usr/bin/env node
// policy-digest.mjs — one digest over the GOVERNING bytes of this pack.
//
// The harness already digests the thing being reviewed (ocr-review manifest,
// ultra-review brief); this digests the thing doing the reviewing. Without it,
// N projects × M hosts drift silently: a failure cannot be attributed to a
// policy version, and "which policy is running here" has no answer.
//
// Digest input: every file under prompts/, extensions/, skills/, templates/,
// plus docs/anti-patterns.md, as sorted (relative-path, sha256(content))
// pairs. Deliberately excluded: config examples (host-local), scripts/ other
// than the policy itself is debatable — scripts ARE governing bytes, included.
//
// Usage:
//   node scripts/policy-digest.mjs                  # print {version, digest, files}
//   node scripts/policy-digest.mjs --write-manifest # refresh manifest.json
//   node scripts/policy-digest.mjs --check          # exit 1 if manifest is stale

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOVERNED = ["prompts", "extensions", "skills", "templates", "scripts"];
const GOVERNED_FILES = ["docs/anti-patterns.md", "config/skill-admission.json"];
const MANIFEST_PATH = join(ROOT, "manifest.json");

function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === ".DS_Store" || entry.name === "__pycache__") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.isFile()) yield full;
	}
}

export function collectGovernedFiles(root = ROOT) {
	const files = [];
	for (const dir of GOVERNED) {
		const full = join(root, dir);
		if (!existsSync(full) || !statSync(full).isDirectory()) continue;
		for (const file of walk(full)) files.push(file);
	}
	for (const rel of GOVERNED_FILES) {
		const full = join(root, rel);
		if (existsSync(full)) files.push(full);
	}
	return files.map((file) => relative(root, file)).sort();
}

export function policyDigest(root = ROOT) {
	const files = collectGovernedFiles(root);
	const hash = createHash("sha256");
	const perFile = {};
	for (const rel of files) {
		const content = readFileSync(join(root, rel));
		const fileHash = createHash("sha256").update(content).digest("hex");
		// POSIX-normalized key: the same governed bytes must yield the same
		// digest on Windows and POSIX hosts, or cross-host drift detection lies.
		const key = rel.split(sep).join("/");
		perFile[key] = `sha256:${fileHash}`;
		hash.update(key).update("\0").update(fileHash).update("\0");
	}
	let version = "0.0.0";
	try { version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? version; }
	catch { /* version stays 0.0.0 */ }
	return {
		schema: "paseo.team-policy-digest/v1",
		version,
		policyDigest: `sha256:${hash.digest("hex")}`,
		fileCount: files.length,
		files: perFile,
	};
}

function main() {
	const argv = process.argv.slice(2);
	const known = new Set(["--write-manifest", "--check", "--json"]);
	for (const token of argv) {
		if (!known.has(token)) {
			console.error(JSON.stringify({ ok: false, error: "unknown_flag", flag: token, known: [...known].sort() }));
			process.exit(2);
		}
	}
	const current = policyDigest();
	if (argv.includes("--write-manifest")) {
		writeFileSync(MANIFEST_PATH, `${JSON.stringify(current, null, 2)}\n`);
		console.log(JSON.stringify({ ok: true, wrote: "manifest.json", policyDigest: current.policyDigest, fileCount: current.fileCount }));
		return;
	}
	if (argv.includes("--check")) {
		let recorded = null;
		try { recorded = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")); }
		catch { /* missing manifest is stale */ }
		const fresh = recorded !== null && recorded.policyDigest === current.policyDigest;
		console.log(JSON.stringify({
			ok: fresh,
			...(fresh ? {} : { error: recorded === null ? "manifest_missing" : "manifest_stale" }),
			recorded: recorded?.policyDigest ?? null,
			current: current.policyDigest,
		}));
		process.exit(fresh ? 0 : 1);
	}
	console.log(JSON.stringify({
		schema: current.schema,
		version: current.version,
		policyDigest: current.policyDigest,
		fileCount: current.fileCount,
	}, null, 2));
}

// The is-main guard must realpath BOTH sides: node resolves import.meta.url
// through symlinks while argv[1] stays literal (and under --preserve-symlinks
// the reverse), so a symlinked invocation would otherwise skip main() and exit
// 0 silently — a fail-open staleness check. Reproduced adversarially in review.
function realOrRaw(path) {
	try { return realpathSync(path); } catch { return path; }
}
const invokedAs = process.argv[1] ? realOrRaw(process.argv[1]) : null;
if (invokedAs !== null && realOrRaw(fileURLToPath(import.meta.url)) === invokedAs) main();
