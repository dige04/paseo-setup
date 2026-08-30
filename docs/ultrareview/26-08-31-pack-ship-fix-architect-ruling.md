# Architect ruling — pack-ship fix cycle (T-FIX-ARCH, agent 75429a89, opus-5 xhigh)

Recorded verbatim-condensed by the Lead on acceptance, 2026-08-31. Full text in the
agent transcript. Read-only seat; all "(measured)" claims from live paseo ls/inspect.

## Verdicts
- F003+F004 = ONE root, ONE change, ONE writer (E1). Root: "the governance graph has
  no agent-identity model" — role/authority/liveness/scope identity derived from
  incidental strings. F004 must NOT ship alone (canonical merge without liveness = flood).
- F015 PROMOTED record-only -> BLOCKING PREREQUISITE for a working A1 gate. Cycle N+1
  with its own architect question: which taxonomy, who produces it, migration, and WHY
  the create-time label gate did not fire (9/24 role-labeled agents evaded it).
- F005+F006 = two roots, one change, one writer (E2). Shared cause: report artifact is
  machine-read with no declared grammar.
- F007 split: CI --check limb in-cycle LAST; ship preflight free via F001 reverse assert;
  deployed-layout limb record-only until sandbox repro.
- REJECTED scout claim F003(d) "collector env not lead's": ls -g is local-daemon, no
  --host — collector env IS host env. Real defect = U7 (two parsers disagree; "0" reads
  enabled) + read-never-used.
- NOT approved this cycle: F012 (scope discipline), F013/F014/F016 (record-only),
  A1/A2/A3/A5 as working exit-3 gates (unreachable until F015; A1 positive control is
  SYNTHETIC — document plainly, do not let a later reader "fix" the suppression).

## Measurements (load-bearing)
- M1: ls.cwd = "~/..." vs inspect.Cwd = "/Users/..." — normalizeAgent picks by inspect
  success => same directory, two A1 keys, EVERY run (self-inflicted split, U1).
- M2: mode ids provider-namespaced, colliding: omp "write" = Write APPROVAL (gated!);
  a flat token table misclassifies (U3). codex "full-access", claude "bypassPermissions".
- M3: harness.role three disjoint vocabularies; enforced enum {observer,writer,reviewer,
  lead,supervisor} has ZERO live instances; fleet carries {peer,scout,architect}.
- M4: live A1 population on this repo = 1 running + 11 idle claude-peer.
- M5: ls excludes archived by default — Archived is not a signal the graph can see.
- M6: ls --json has no labels BUT `paseo ls --label k=v` is a working server-side filter
  (the graph's "no second source" header comment is false).
- M7: 141 non-archived agents global vs maxAgents 100 — --assert --all truncated on this
  host today (honestly signalled; U9 record-only).

## Uncited defect sites
U1 spelling split (above). U2 EMPTY SCOPE = unconditional green exit 0 — belongs in A6
as a VIOLATION ("a scan of nothing must never read as a pass"). U3 omp "write"
misclassified as confirmed writer. U4 A1 filters role==="peer" so the whole
omp/agy/codex fleet is invisible to it. U5 A1 true-positive branch UNREACHABLE on any
real fleet configuration (flagship invariant vacuous until F015). U6 = M3. U7
PASEO_TEAM_LEAD_WRITE two parsers disagree. U8 quiet_day:true when ALL sources missing.
U9 = M7.

## E1 design (identity — governance-graph)
(a) MOVE resolveCanonicalCwds + normalizePaseoCwd from reconcile-observer.mjs to
lib-common.mjs; observer imports from new home, ZERO behavior change (reconcile tests
are the regression guard, read-only for E1). Cost settled: realpath is 3 orders below
the execFile fan-out. (b) normalizeAgent gains canonicalCwd; raw spelling display-only;
null canonical => per-scope cannotVerify with resolve error (never silently dropped).
(c) inScope compares canonical values. (d) NEW enforcementClass(provider) ->
pack-enforced|unenforced|unknown; for pack-enforced seats MODE IS NOT WRITE AUTHORITY.
(e) writePosture re-keyed to (provider, modeId), frozen table with per-entry provenance,
default unknown; completeness check reports unclassified Mode with that agent's own
AvailableModes label. (f) A1 = canonical scope key AND status==="running" AND posture
only for unenforced seats; pack-enforced => one cannotVerify per scope; non-running
write-capable => ONE advisory line per scope naming reconcile-observer as owner (flood
control: M4's 11 idle -> 1 line); advisories live in cannotVerify (exit 0). Include the
code comment separating "may I archive?" (idle not evidence) from "is something mutating
now?" (running is the only available evidence). (g) A2 -> advisory until F015; fix U7
with one predicate shared or parity-tested against policy-core; label collector-local.
(h) A3 -> advisory until F015. (i) A5 split: delegation leg (ParentAgentId, fact-based)
STAYS exit-3; posture leg -> advisory. (j) A6 gains U2: scopedTotal===0 && listedTotal>0
under --assert = VIOLATION. (k) honesty: docs + AP wiring say A1 vacuous until F015.
Killing tests (same change): two-spelling+symlink fixture -> 1 scope, 1 violation with
an unenforced running pair; M4 fixture -> 0 violations + exactly 1 advisory; empty-scope
-> A6 violation exit 3 (REAL CLI via PASEO_TEAM_PASEO_EXEC fixture — prerequisite of
accepting R1); mode-table completeness over measured AvailableModes; leadWrite parity
over {"","0","false","no","1","true","yes"}.
Internal order: helper move -> canonical ingest -> A6 empty-scope -> A1 clauses ->
demotions -> mode table -> process-boundary control.

## E2 design (grammar — report artifact)
(a) ultra-review-report.mjs is the ONE grammar owner: export GATE_FIELDS, parseGateLine,
parseReport, checkReportGate(text) recomputing findingAction() -> first production
consumer IN ITS OWN MODULE; eod-digest imports and deletes private regexes. (b) `Gate: v1`
in template header; reports lacking it = pre-gate DECLARED (one anomaly per FILE, 0
decisions) — never inferred from absence of Action lines. (c) gate-line grammar:
`Convergence: n/m | Reproduced: yes|no|partial | Contract-breaker: yes|no | Action:
fix-eligible|record-only`; unchosen/TODO/unknown -> unknown + anomaly; Contract-breaker
EXPLICIT field; `partial` is a real token. (d) dedicated `Applied: yes|no` line; DELETE
the \bapplied\b substring scan AND the table-agnostic ^|F\d+ row scan. (e) Trade-off
line: required non-empty non-TODO on fix-eligible, else anomaly. (f) unreadable report
=> reports.status broken (footer stops lying). (g) U8: quiet_day requires ALL FOUR
sources scanned. (h) verify manifest.policyDigest vs computed policyDigest(workspace);
mismatch = anomaly. (i) --date round-trips through Date.
Enforcement point (Q3): checker WITH the gate (ultra-review-report), digest CALLS it;
second automatic caller = CI over docs/ultrareview/*.md checking only `Gate: v1` files.
Interim: downgrade AP-04 wiring row mechanism->rule NOW, restore when two callers exist.
Killing tests: round-trip parseReport(markdownTemplate(...)) -> all-unknown + exact
anomaly set (THE drift mechanism); "(not applied)" -> applied false; "fix-eligible/
record-only" -> unknown+anomaly; seeded below-gate fix-eligible -> disagreement anomaly;
pre-gate 25-finding report -> exactly 1 anomaly 0 decisions; all-missing -> quiet_day
false.

## Sequencing
F001 first (Lead-owned: installers + reverse-direction ship assert; ships preflight
free). E1 ∥ E2 (disjoint scopes, no barrier). Lead-owned: manifest.json regenerated ONCE
at integration (never by engineers). CI --check limb LAST after merge + regen.
E1 scope: scripts/governance-graph.mjs, scripts/lib-common.mjs, test/governance-graph*,
test/lib-common.test.mjs, docs/governance-graph.md, + import-line-only edit in
scripts/reconcile-observer.mjs.
E2 scope: scripts/ultra-review-report.mjs, scripts/eod-digest.mjs, their two test files,
templates/, skills/paseo-ultra-review/SKILL.md, docs/anti-patterns.md (AP-04 row).
No file in both scopes.

## Lead acceptance note
Accepted in full 2026-08-31. Counter-invitation on §7/R-1 declined: no evidence the
enforced role vocabulary is producible today — this session's own fleet was created via
MCP outside the hook (which IS the "why did the gate not fire" answer: the create-time
gate binds claude-* seats' tool calls, not the Lead session's direct MCP calls).
F015 -> cycle N+1 as ruled. Writer≠acceptor note: F001 lands by the Lead per the
ruling's scope assignment; its independent acceptance rides the cycle's reviewer pass.
