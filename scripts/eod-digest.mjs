#!/usr/bin/env node
// eod-digest.mjs — deterministic Tier-1 end-of-day digest (no LLM).
//
// Assembles one day's evidence — ultra-review reports, supervisor notebook,
// policy manifest, git log — into a DECISION-ORIENTED markdown digest per the
// "Digest style" standing rule in docs/self-improve.md: sections render only
// when non-empty, routine healthy status is omitted, and a quiet day yields a
// SHORT digest saying so. Empty is a first-class output; padding is not.
// Tier-2 (analysis) stays with vendor/better-harness.
//
// Fail-closed accounting: a missing source is REPORTED in the footer, never
// silently skipped; an unfilled Action or Escalation field surfaces as
// cannot_verify, never as pass. Totals are precomputed and every cap
// (20 commit subjects, ~200 digest lines) signals truncation explicitly, so a
// capped listing can never read as a total.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isEntrypoint } from "./lib-common.mjs";

export const EOD_DIGEST_ERROR_CODES = Object.freeze(["USAGE", "WORKSPACE_MISSING"]);
export const MAX_COMMIT_SUBJECTS = 20;
export const MAX_DIGEST_LINES = 200;

export class EodDigestError extends Error {
	constructor(code, message) {
		super(`${code}: ${message}`);
		this.name = "EodDigestError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new EodDigestError(code, message);
}

const DATE_SLUG = /^\d{2}-\d{2}-\d{2}$/;

/** Local-time yy-mm-dd, same derivation as ultra-review-report.mjs. */
function todaySlug(now = new Date()) {
	return `${String(now.getFullYear()).slice(2)}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Parse one ultra-review report's findings and scout accounting.
 *
 * A finding is a `### F<nnn> …` heading; its Action is the first
 * `Action: <token>` inside the block. "Applied" is recognized three ways —
 * `applied` on the Action line itself, an `Applied: yes` line in the block,
 * or the finding ID as the first cell of a table row (the "Applied fixes"
 * table in real reports). Fail-closed: a missing/TODO Action is `unknown`,
 * never a pass; an unrecognized Action value is additionally an anomaly.
 *
 * SCOUTS_MISSING: `0`/`none` is clean; a non-empty value is an anomaly; an
 * unfilled value or an absent line means scout coverage cannot be verified,
 * which is itself an anomaly rather than silence.
 */
export function parseReportFindings(text) {
	const source = String(text ?? "");
	const findings = [];
	const scoutsMissing = [];
	const anomalies = [];

	let sawScoutsMissing = false;
	for (const match of source.matchAll(/SCOUTS_MISSING:\s*([^`\n]*)/g)) {
		sawScoutsMissing = true;
		const value = match[1].trim();
		if (value === "" || /^TODO\b/.test(value)) {
			anomalies.push("SCOUTS_MISSING is unfilled — scout coverage cannot be verified");
		} else if (!/^(0|none)$/i.test(value)) {
			scoutsMissing.push(value);
		}
	}
	if (!sawScoutsMissing) {
		anomalies.push("no SCOUTS_MISSING line — scout coverage cannot be verified");
	}

	const appliedIds = new Set();
	for (const match of source.matchAll(/^\|\s*(F\d+)\b/gm)) appliedIds.add(match[1]);

	const headings = [...source.matchAll(/^###\s+(F\d+)\b([^\n]*)$/gm)];
	for (let i = 0; i < headings.length; i++) {
		const [headingLine, id, rest] = headings[i];
		const start = headings[i].index + headingLine.length;
		const end = i + 1 < headings.length ? headings[i + 1].index : source.length;
		let block = source.slice(start, end);
		const sectionBreak = block.search(/^##\s/m);
		if (sectionBreak !== -1) block = block.slice(0, sectionBreak);

		const title = rest.replace(/^[\s·—:|[\]-]+/, "").trim();
		let action = "unknown";
		let reason = "no Action line";
		let applied = appliedIds.has(id);

		const actionLine = block.match(/^[^\n]*\bAction:\s*([A-Za-z-]+)[^\n]*$/m);
		if (actionLine) {
			const token = actionLine[1];
			if (token === "fix-eligible" || token === "record-only") {
				action = token;
				reason = null;
				if (/\bapplied\b/i.test(actionLine[0])) applied = true;
			} else if (/^TODO$/i.test(token)) {
				reason = "Action is unfilled (TODO)";
			} else {
				reason = `unrecognized Action value "${token}"`;
				anomalies.push(`${id}: unrecognized Action value "${token}"`);
			}
		}
		if (/^\s*Applied:\s*(yes|true)\b/im.test(block)) applied = true;

		findings.push({ id, title, action, applied, reason });
	}

	return { findings, scoutsMissing, anomalies };
}

/**
 * Parse supervisor-notebook records whose "Scope + date" line contains the
 * digest date (short yy-mm-dd or full 20yy-mm-dd form). Records are `###`
 * headings; blocks without a "Scope + date" line (the template's record-shape
 * example) are not records. Fail-closed on escalation: a missing or unfilled
 * "Escalation needed" is a decision item with a cannot_verify reason — only a
 * literal "no" clears it.
 */
export function parseNotebookRecords(text, dateSlug) {
	if (!DATE_SLUG.test(String(dateSlug ?? ""))) {
		fail("USAGE", "parseNotebookRecords requires a yy-mm-dd date");
	}
	const source = String(text ?? "");
	const fullDate = `20${dateSlug}`;
	const records = [];
	const headings = [...source.matchAll(/^###\s+([^\n]+)$/gm)];
	for (let i = 0; i < headings.length; i++) {
		const heading = headings[i][1].trim();
		const start = headings[i].index;
		const end = i + 1 < headings.length ? headings[i + 1].index : source.length;
		const block = source.slice(start, end);

		const scopeMatch = block.match(/^Scope \+ date:\s*([^\n]*)$/m);
		if (!scopeMatch) continue;
		const scope = scopeMatch[1].trim();
		if (!scope.includes(fullDate) && !scope.includes(dateSlug)) continue;

		const escalationMatch = block.match(/^Escalation needed:\s*([^\n]*)$/m);
		let escalation = null;
		let needsDecision;
		let reason;
		if (!escalationMatch) {
			needsDecision = true;
			reason = "Escalation needed field missing — cannot verify";
		} else {
			escalation = escalationMatch[1].trim();
			if (escalation === "") {
				needsDecision = true;
				reason = "Escalation needed is unfilled — cannot verify";
			} else if (/^no\.?$/i.test(escalation)) {
				needsDecision = false;
				reason = null;
			} else {
				needsDecision = true;
				reason = `Escalation needed: ${escalation}`;
			}
		}
		records.push({ heading, scope, escalation, needsDecision, reason });
	}
	return records;
}

/** git commit subjects for the date. Impure (spawns git); not part of the
 * exported pure surface, but kept separate so buildDigest never touches IO. */
function collectGitLog(workspace, dateSlug) {
	const day = `20${dateSlug}`;
	const empty = { totalCommits: 0, subjects: [], truncated: false };
	const probe = spawnSync("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
	if (probe.error) {
		return { status: "missing", reason: `git unavailable: ${String(probe.error.message ?? probe.error)}`, ...empty };
	}
	if (probe.status !== 0 || probe.stdout.trim() !== "true") {
		return { status: "missing", reason: "workspace is not a git repository", ...empty };
	}
	const log = spawnSync(
		"git",
		["-C", workspace, "log", `--since=${day} 00:00:00`, `--until=${day} 23:59:59`, "--pretty=format:%s"],
		{ encoding: "utf8" },
	);
	if (log.error || log.status !== 0) {
		const stderr = String(log.stderr ?? log.error?.message ?? "").trim();
		// A repo with zero commits is an empty day, not a broken source.
		if (/does not have any commits yet|bad default revision|unknown revision/i.test(stderr)) {
			return { status: "scanned", ...empty };
		}
		return { status: "failed", reason: `git log failed: ${stderr || "unknown error"}`, ...empty };
	}
	const subjects = log.stdout.split("\n").filter((line) => line.trim() !== "");
	return {
		status: "scanned",
		totalCommits: subjects.length,
		subjects: subjects.slice(0, MAX_COMMIT_SUBJECTS),
		truncated: subjects.length > MAX_COMMIT_SUBJECTS,
	};
}

/**
 * Pure digest assembly over pre-gathered source structs. Section order is
 * fixed: Decisions needed, Anomalies, Applied changes, Review activity, then
 * ALWAYS the accounting footer. Sections render only when non-empty. Output
 * is hard-capped at MAX_DIGEST_LINES with an explicit truncation marker; the
 * footer always survives the cap.
 */
export function buildDigest({ date, reports, notebook, manifest, git }) {
	if (!DATE_SLUG.test(String(date ?? ""))) fail("USAGE", "buildDigest requires a yy-mm-dd date");
	reports = reports ?? { status: "missing", reason: "not provided", files: [] };
	notebook = notebook ?? { status: "missing", reason: "not provided", records: [] };
	manifest = manifest ?? { status: "missing", reason: "not provided" };
	git = git ?? { status: "missing", reason: "not provided", totalCommits: 0, subjects: [], truncated: false };

	const decisions = [];
	let findingsTotal = 0;
	let fixEligible = 0;
	let recordOnly = 0;
	let unverifiable = 0;
	for (const file of reports.files) {
		for (const finding of file.findings) {
			findingsTotal += 1;
			if (finding.action === "fix-eligible") fixEligible += 1;
			else if (finding.action === "record-only") recordOnly += 1;
			else unverifiable += 1;
			if (finding.action === "fix-eligible" && !finding.applied) {
				decisions.push(`[${file.name}] ${finding.id} — fix-eligible, not marked applied${finding.title ? `: ${finding.title}` : ""}`);
			} else if (finding.action !== "fix-eligible" && finding.action !== "record-only") {
				decisions.push(`[${file.name}] ${finding.id} — cannot_verify: ${finding.reason}`);
			}
		}
	}
	for (const record of notebook.records) {
		if (record.needsDecision) decisions.push(`[supervisor-notebook] ${record.heading} — ${record.reason}`);
	}

	const anomalies = [];
	for (const file of reports.files) {
		for (const value of file.scoutsMissing) anomalies.push(`[${file.name}] SCOUTS_MISSING: ${value}`);
		for (const note of file.anomalies) anomalies.push(`[${file.name}] ${note}`);
	}
	if (notebook.status === "malformed") anomalies.push(`[docs/supervisor-notebook.md] ${notebook.reason}`);
	if (manifest.status === "malformed") anomalies.push(`[manifest.json] ${manifest.reason}`);
	if (git.status === "failed") anomalies.push(`[git] ${git.reason}`);

	const appliedChanges = git.subjects.map((subject) => `- ${subject}`);
	if (git.truncated) {
		appliedChanges.push(
			`- … ${git.totalCommits - git.subjects.length} more commit(s) not shown (${git.totalCommits} total; subjects capped at ${MAX_COMMIT_SUBJECTS})`,
		);
	}

	const activity = [];
	if (reports.status === "scanned" && reports.files.length > 0) {
		activity.push(
			`- Ultra-review reports dated ${date}: ${reports.files.length} · findings ${findingsTotal} (fix-eligible ${fixEligible} · record-only ${recordOnly} · unverifiable ${unverifiable})`,
		);
	}
	if (notebook.status === "scanned" && notebook.records.length > 0) {
		const open = notebook.records.filter((record) => record.needsDecision).length;
		activity.push(`- Notebook records dated ${date}: ${notebook.records.length} (open escalations ${open})`);
	}

	const body = [];
	const pushSection = (title, lines) => {
		if (lines.length > 0) body.push(`## ${title}`, "", ...lines, "");
	};
	pushSection("Decisions needed", decisions.map((item) => `- ${item}`));
	pushSection("Anomalies", anomalies.map((item) => `- ${item}`));
	pushSection("Applied changes", appliedChanges);
	pushSection("Review activity", activity);
	const quietDay = body.length === 0;
	if (quietDay) {
		body.push(`Quiet day — no decisions needed, no anomalies, no commits, no review activity dated ${date}.`, "");
	}

	const headerLines = [`# EOD Digest — ${date}`, ""];
	const statuses = [reports.status, notebook.status, manifest.status, git.status];
	const scannedCount = statuses.filter((status) => status === "scanned").length;
	const missingCount = statuses.filter((status) => status === "missing").length;
	const brokenCount = statuses.length - scannedCount - missingCount;
	const sourceLine = (name, info, detail) =>
		info.status === "scanned" ? `- ${name}: scanned${detail ? ` (${detail})` : ""}` : `- ${name}: ${info.status} — ${info.reason}`;
	const footerLines = (digestTruncated) => {
		const flags = [];
		if (git.truncated) flags.push(`commit subjects capped at ${MAX_COMMIT_SUBJECTS} of ${git.totalCommits}`);
		if (digestTruncated) flags.push(`digest capped at ${MAX_DIGEST_LINES} lines`);
		return [
			"## Accounting",
			"",
			`- Date: ${date} · sources scanned ${scannedCount}/${statuses.length} · missing ${missingCount} · malformed/failed ${brokenCount}`,
			sourceLine("docs/ultrareview/", reports, `${reports.files.length} report(s) dated ${date}`),
			sourceLine("docs/supervisor-notebook.md", notebook, `${notebook.records.length} record(s) dated ${date}`),
			sourceLine("manifest.json", manifest, ""),
			sourceLine("git log", git, `${git.totalCommits} commit(s) dated ${date}`),
			`- Counts: decisions ${decisions.length} · anomalies ${anomalies.length} · findings ${findingsTotal} · notebook records ${notebook.records.length} · commits ${git.totalCommits}`,
			manifest.status === "scanned"
				? `- Policy digest: ${manifest.policyDigest} (fileCount ${manifest.fileCount})`
				: `- Policy digest: unavailable — manifest.json ${manifest.status}`,
			`- Truncation: ${flags.length ? flags.join("; ") : "none"}`,
		];
	};

	let digestTruncated = false;
	let lines = [...headerLines, ...body, ...footerLines(false)];
	if (lines.length > MAX_DIGEST_LINES) {
		digestTruncated = true;
		const footer = footerLines(true);
		const budget = Math.max(MAX_DIGEST_LINES - headerLines.length - footer.length - 1, 0);
		const kept = body.slice(0, budget);
		kept.push(`… digest truncated: ${body.length - kept.length} body line(s) omitted to stay within ${MAX_DIGEST_LINES} lines`);
		lines = [...headerLines, ...kept, ...footer];
	}

	const sourceMeta = (info) => ({ status: info.status, ...(info.reason ? { reason: info.reason } : {}) });
	return {
		markdown: `${lines.join("\n")}\n`,
		metadata: {
			schema: "paseo.eod-digest/v1",
			date,
			quiet_day: quietDay,
			counts: {
				decisions: decisions.length,
				anomalies: anomalies.length,
				reports: reports.files.length,
				findings: findingsTotal,
				fix_eligible: fixEligible,
				record_only: recordOnly,
				unverifiable,
				notebook_records: notebook.records.length,
				commits_total: git.totalCommits,
				commits_shown: git.subjects.length,
			},
			sources: {
				ultrareview: sourceMeta(reports),
				notebook: sourceMeta(notebook),
				manifest: sourceMeta(manifest),
				git: sourceMeta(git),
			},
			policy_digest: manifest.status === "scanned" ? manifest.policyDigest : null,
			file_count: manifest.status === "scanned" ? manifest.fileCount : null,
			truncation: { commit_subjects: Boolean(git.truncated), digest_lines: digestTruncated },
			digest_line_count: lines.length,
		},
	};
}

export function parseArgs(argv) {
	const options = { workspace: null, date: null, out: null, json: false, dryRun: false };
	const valued = new Set(["--workspace", "--date", "--out"]);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--dry-run") {
			options.dryRun = true;
		} else if (valued.has(arg)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) fail("USAGE", `${arg} requires a value`);
			options[arg.slice(2)] = value;
		} else {
			fail("USAGE", `unknown argument "${arg}"`);
		}
	}
	if (options.help) return options;
	if (!options.workspace) fail("USAGE", "--workspace is required");
	if (options.date !== null && !DATE_SLUG.test(options.date)) fail("USAGE", "--date must use yy-mm-dd format");
	return options;
}

export function main(options) {
	const workspace = resolve(options.workspace);
	if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
		fail("WORKSPACE_MISSING", `workspace does not exist or is not a directory: ${workspace}`);
	}
	const date = options.date ?? todaySlug();

	const reportDir = join(workspace, "docs", "ultrareview");
	let reports;
	if (!existsSync(reportDir)) {
		reports = { status: "missing", reason: "docs/ultrareview/ not found", files: [] };
	} else {
		const names = readdirSync(reportDir)
			.filter((name) => name.endsWith(".md") && name.startsWith(`${date}-`))
			.sort();
		const files = names.map((name) => {
			try {
				return { name, ...parseReportFindings(readFileSync(join(reportDir, name), "utf8")) };
			} catch (error) {
				return {
					name,
					findings: [],
					scoutsMissing: [],
					anomalies: [`unreadable report: ${String(error?.message ?? error)}`],
				};
			}
		});
		reports = { status: "scanned", files };
	}

	const notebookPath = join(workspace, "docs", "supervisor-notebook.md");
	let notebook;
	if (!existsSync(notebookPath)) {
		notebook = { status: "missing", reason: "docs/supervisor-notebook.md not found", records: [] };
	} else {
		try {
			notebook = { status: "scanned", records: parseNotebookRecords(readFileSync(notebookPath, "utf8"), date) };
		} catch (error) {
			notebook = { status: "malformed", reason: `unreadable notebook: ${String(error?.message ?? error)}`, records: [] };
		}
	}

	const manifestPath = join(workspace, "manifest.json");
	let manifest;
	if (!existsSync(manifestPath)) {
		manifest = { status: "missing", reason: "manifest.json not found at workspace root" };
	} else {
		try {
			const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (typeof parsed?.policyDigest !== "string" || !Number.isInteger(parsed?.fileCount)) {
				manifest = { status: "malformed", reason: "manifest.json lacks a string policyDigest and an integer fileCount" };
			} else {
				manifest = { status: "scanned", policyDigest: parsed.policyDigest, fileCount: parsed.fileCount };
			}
		} catch (error) {
			manifest = { status: "malformed", reason: `manifest.json is not valid JSON: ${String(error?.message ?? error)}` };
		}
	}

	const git = collectGitLog(workspace, date);

	const { markdown, metadata } = buildDigest({ date, reports, notebook, manifest, git });

	let outPath = null;
	if (options.out) {
		outPath = resolve(options.out);
		if (!options.dryRun) {
			mkdirSync(dirname(outPath), { recursive: true });
			writeFileSync(outPath, markdown, { encoding: "utf8" });
		}
	}

	return { markdown, metadata: { ...metadata, out: outPath, dry_run: Boolean(options.dryRun) } };
}

function help() {
	return `eod-digest.mjs — deterministic Tier-1 end-of-day digest (no LLM)

Usage:
  node <PASEO_TEAM_SCRIPTS_DIR>/eod-digest.mjs \\
    --workspace <repo-root> [--date yy-mm-dd] [--out <path>] [--json] [--dry-run]

Sources, all optional-missing-tolerated (a missing source is REPORTED in the
accounting footer, never silently skipped):
  docs/ultrareview/<date>-*.md   per-finding Action values + SCOUTS_MISSING
  docs/supervisor-notebook.md    records whose "Scope + date" contains the date
  manifest.json                  policyDigest + fileCount attribution
  git log                        commit subjects for the date (cap ${MAX_COMMIT_SUBJECTS}, truncation signalled)

Decision-oriented output: sections render only when non-empty, in the order
Decisions needed / Anomalies / Applied changes / Review activity, then ALWAYS
an accounting footer. A quiet day yields a short digest saying so. Output is
hard-capped at ${MAX_DIGEST_LINES} lines with an explicit truncation marker.

--json prints a metadata envelope to stdout instead of the digest markdown.
--out additionally writes the digest to a file; --dry-run skips that write.`;
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
	return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log(help());
		} else {
			const { markdown, metadata } = main(options);
			if (options.json) {
				console.log(JSON.stringify({ ok: true, ...metadata }, null, 2));
			} else {
				process.stdout.write(markdown);
			}
		}
	} catch (error) {
		const code = error instanceof EodDigestError ? error.code : "USAGE";
		const message = error instanceof EodDigestError ? error.message : String(error?.message ?? error);
		console.log(JSON.stringify({ ok: false, code, message }));
		process.exitCode = 2;
	}
}
