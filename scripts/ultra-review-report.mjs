#!/usr/bin/env node
// ultra-review-report.mjs — deterministic ultra-review report scaffold.
//
// This script owns the report path, the round number, and the markdown
// skeleton so the coordinating Lead cannot improvise an artifact name or
// section layout between rounds. Round N+1 must be discoverable from round N.
//
// Ported from the upstream Python `create_ultra_review_report.py`. Rewritten
// in Node because the role pack ships no Python dependency, and because the
// upstream invocation hardcoded one machine's absolute path — the installed
// copy is resolved through PASEO_TEAM_SCRIPTS_DIR instead.
//
// It writes exactly one file and nothing else. It never edits source, runs
// tests, or calls an LLM.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { isEntrypoint } from "./lib-common.mjs";

export const ULTRA_REVIEW_ERROR_CODES = Object.freeze([
	"USAGE",
	"WORKSPACE_MISSING",
	"REPORT_EXISTS",
]);

export class UltraReviewError extends Error {
	constructor(code, message) {
		super(`${code}: ${message}`);
		this.name = "UltraReviewError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new UltraReviewError(code, message);
}

/** Lowercase kebab slug. Throws rather than silently producing an empty name,
 * because an empty slug would collide every review into one filename. */
export function slugify(value) {
	const slug = String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!slug) fail("USAGE", "review name slug is empty");
	return slug;
}

const toPosix = (value) => value.split(sep).join(posix.sep);

/**
 * Next round number for this review name, plus the prior reports in order.
 *
 * Rounds are derived from what is on disk, not from a counter the caller
 * passes in: a Lead that lost context between rounds must not be able to
 * overwrite round 1 by starting over at 1.
 */
export function nextRound(reportDir, reviewName) {
	const pattern = new RegExp(`^\\d{2}-\\d{2}-\\d{2}-${reviewName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-round-(\\d+)\\.md$`);
	const prior = [];
	if (existsSync(reportDir)) {
		for (const entry of readdirSync(reportDir)) {
			const match = pattern.exec(entry);
			if (match) prior.push({ round: Number(match[1]), name: entry });
		}
	}
	prior.sort((a, b) => a.round - b.round);
	return {
		round: prior.length === 0 ? 1 : prior[prior.length - 1].round + 1,
		priorReports: prior.map((item) => item.name),
	};
}

export function markdownTemplate({
	dateSlug,
	reviewName,
	roundNumber,
	scope,
	reportPath,
	priorReports,
	reviewBriefSha256,
	scoutCount,
	directiveCount,
}) {
	const priorLines = priorReports.length
		? priorReports.map((name) => `- docs/ultrareview/${name}`).join("\n")
		: "- none";
	return `# Ultra Review: ${reviewName} Round ${roundNumber}

Date: ${dateSlug}
Review name: ${reviewName}
Round: ${roundNumber}
Scope: ${scope}
Report path: ${reportPath}
Review brief SHA256: ${reviewBriefSha256}
Scouts launched: ${scoutCount}
Directives: ${directiveCount}

## Prior Round Guard

Previous reports read:
${priorLines}

## Scout Roster

<!--
One row per LOGICAL scout. Replacement attempts after a restart keep the same
logical ID; never add an extra logical scout to cover a failure.
-->

| Scout | Concerns | AGENT_REF | MODEL_CLASS | Status |
|---|---|---|---|---|
| scout-01 | TODO | TODO | FAST_READ | TODO submitted / missing |

## Findings

<!--
Every candidate reported by a scout must be captured here. Do not filter out
speculative, low-confidence, duplicated, or hard-to-classify candidates —
rejection belongs to the later verification pass, not to consolidation.
If there are no candidates, write: No candidates reported.
-->

### F001 [P?] TODO short title

Severity: P? | Confidence: high/medium/low
Reported by: TODO scout IDs
Source pointer: TODO file:line
Evidence:
- TODO file:line and observed behavior, or unknown
Contract violated:
- TODO expected behavior vs observed pattern
Plausible failure mode:
- TODO how it breaks, under what condition/input/timing
Durable solution hypothesis:
- TODO owner-clean long-term fix
Disconfirming check:
- TODO read-only check that would prove this false

## Verification Queue

- F001: TODO read-only disconfirming check

## Coverage And Limits

TOTAL_CANDIDATES:
FINDINGS:
SCOUTS_PLANNED:
SCOUTS_SUBMITTED:
SCOUTS_MISSING:
REVIEW_LIMITATIONS: none | TODO concrete limitation and affected area

## Strongest Reason Not To Merge Yet

TODO

## Handoff

Findings are candidates, not an acceptance decision. The Lead owns acceptance;
a human owns merge and deploy. Corrections return to the original Engineer,
who creates a new commit SHA — never an amend.
`;
}

export function parseArgs(argv) {
	const options = { workspace: process.cwd(), date: null, dryRun: false };
	const valued = new Set(["--workspace", "--review-name", "--scope", "--review-brief-sha256", "--scout-count", "--directive-count", "--date"]);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--dry-run") {
			options.dryRun = true;
		} else if (valued.has(arg)) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) fail("USAGE", `${arg} requires a value`);
			options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
		} else {
			fail("USAGE", `unknown argument "${arg}"`);
		}
	}
	if (options.help) return options;

	if (!options.reviewName) fail("USAGE", "--review-name is required");
	options.reviewName = slugify(options.reviewName);
	if (!options.scope || !options.scope.trim()) fail("USAGE", "--scope is required");
	options.scope = options.scope.trim();
	if (!/^[0-9a-f]{64}$/.test(options.reviewBriefSha256 ?? "")) {
		fail("USAGE", "--review-brief-sha256 must be 64 lowercase hexadecimal characters");
	}
	const scoutCount = Number(options.scoutCount);
	if (!Number.isInteger(scoutCount) || scoutCount <= 0) fail("USAGE", "--scout-count must be a positive integer");
	options.scoutCount = scoutCount;
	const directiveCount = Number(options.directiveCount);
	if (!Number.isInteger(directiveCount) || directiveCount < 0) fail("USAGE", "--directive-count must be a non-negative integer");
	options.directiveCount = directiveCount;
	if (options.date !== null && options.date !== undefined && !/^\d{2}-\d{2}-\d{2}$/.test(options.date)) {
		fail("USAGE", "--date must use yy-mm-dd format");
	}
	return options;
}

export function main(options) {
	const workspace = resolve(options.workspace);
	if (!existsSync(workspace)) fail("WORKSPACE_MISSING", `workspace does not exist: ${workspace}`);

	const now = new Date();
	const dateSlug =
		options.date ??
		`${String(now.getFullYear()).slice(2)}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

	const reportDir = join(workspace, "docs", "ultrareview");
	const { round, priorReports } = nextRound(reportDir, options.reviewName);
	const relativeReportPath = toPosix(join("docs", "ultrareview", `${dateSlug}-${options.reviewName}-round-${round}.md`));
	const reportPath = join(workspace, relativeReportPath);

	if (existsSync(reportPath)) fail("REPORT_EXISTS", `refusing to overwrite existing report: ${relativeReportPath}`);

	const content = markdownTemplate({
		dateSlug,
		reviewName: options.reviewName,
		roundNumber: round,
		scope: options.scope,
		reportPath: relativeReportPath,
		priorReports,
		reviewBriefSha256: options.reviewBriefSha256,
		scoutCount: options.scoutCount,
		directiveCount: options.directiveCount,
	});

	if (!options.dryRun) {
		mkdirSync(reportDir, { recursive: true });
		writeFileSync(reportPath, content, { encoding: "utf8" });
	}

	return {
		metadata: {
			schema: "paseo.ultra-review-report/v1",
			review_name: options.reviewName,
			round,
			report_path: relativeReportPath,
			prior_reports: priorReports.map((name) => `docs/ultrareview/${name}`),
			review_brief_sha256: options.reviewBriefSha256,
			scout_count: options.scoutCount,
			directive_count: options.directiveCount,
			dry_run: Boolean(options.dryRun),
		},
		content,
	};
}

function help() {
	return `ultra-review-report.mjs — deterministic ultra-review report scaffold

Usage:
  node <PASEO_TEAM_SCRIPTS_DIR>/ultra-review-report.mjs \\
    --workspace <repo-root> \\
    --review-name <slug> \\
    --scope "<scope>" \\
    --review-brief-sha256 <sha256> \\
    --scout-count <n> \\
    --directive-count <n> \\
    [--date yy-mm-dd] [--dry-run]

Owns the report path and round number so rounds stay discoverable. Refuses to
overwrite an existing report. Writes one file and nothing else.`;
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
			const { metadata, content } = main(options);
			console.log(JSON.stringify(metadata, null, 2));
			console.log("---BEGIN ULTRA REVIEW TEMPLATE---");
			process.stdout.write(content);
			console.log("---END ULTRA REVIEW TEMPLATE---");
		}
	} catch (error) {
		const code = error instanceof UltraReviewError ? error.code : "USAGE";
		const message = error instanceof UltraReviewError ? error.message : String(error?.message ?? error);
		console.log(JSON.stringify({ ok: false, code, message }));
		process.exitCode = 2;
	}
}
