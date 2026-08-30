#!/usr/bin/env node
// check-report-gates.mjs — the convergence gate's second automatic caller.
//
// Walks a directory of ultra-review reports and re-runs checkReportGate()
// over every `Gate: v1` report. CI calls this so a hand-written Action that
// disagrees with findingAction(), or a fix-eligible finding missing its
// Trade-off statement, fails the PR that carries it — pre-merge, not at EOD.
// Pre-gate reports (no `Gate: v1` marker) pass by declaration.
//
// Extracted to a file (rather than inline CI script) so the exit wiring and
// the pre-gate skip are testable through a real process boundary — an inline
// CI script is a gate nothing can prove alive (pack-ship fix-cycle R1).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isEntrypoint } from "./lib-common.mjs";
import { checkReportGate } from "./ultra-review-report.mjs";

export const CHECK_REPORT_GATES_ERROR_CODES = Object.freeze(["USAGE", "DIR_MISSING"]);

/**
 * Check every .md report in a directory. Returns per-file results plus
 * counts. A gated report with anomalies is a failure; pre-gate reports are
 * declared legacies and never fail here.
 */
export function checkReportsDir(dir) {
	const files = [];
	let gated = 0;
	let preGate = 0;
	let failed = 0;
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".md")) continue;
		const result = checkReportGate(readFileSync(join(dir, name), "utf8"));
		if (result.preGate) {
			preGate += 1;
			files.push({ name, preGate: true, anomalies: [] });
			continue;
		}
		gated += 1;
		if (result.anomalies.length > 0) failed += 1;
		files.push({ name, preGate: false, anomalies: result.anomalies });
	}
	return { files, gated, preGate, failed };
}

export function main(argv) {
	const args = argv.filter((a) => a !== "");
	if (args.some((a) => a.startsWith("-"))) {
		console.log(JSON.stringify({ ok: false, code: "USAGE", message: "usage: check-report-gates.mjs [<reports-dir>]" }));
		return 2;
	}
	const dir = resolve(args[0] ?? join("docs", "ultrareview"));
	if (!existsSync(dir)) {
		console.log(JSON.stringify({ ok: false, code: "DIR_MISSING", message: `reports directory does not exist: ${dir}` }));
		return 2;
	}
	const { files, gated, preGate, failed } = checkReportsDir(dir);
	for (const file of files) {
		if (file.preGate) {
			console.log(`pre-gate: ${file.name}`);
		} else if (file.anomalies.length > 0) {
			console.error(`GATE: ${file.name}`);
			for (const anomaly of file.anomalies) console.error(`  - ${anomaly}`);
		} else {
			console.log(`clean: ${file.name}`);
		}
	}
	console.log(`gate check: gated=${gated} pregate=${preGate} failed=${failed}`);
	return failed > 0 ? 1 : 0;
}

export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
	return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
	process.exitCode = main(process.argv.slice(2));
}
