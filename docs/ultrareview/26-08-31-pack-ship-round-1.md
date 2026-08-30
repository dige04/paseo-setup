# Ultra Review: pack-ship Round 1

Date: 26-08-31
Review name: pack-ship
Round: 1
Scope: Qualify the governance pack for daily multi-PR operation: gates, root-fix, digest, topology asserts, installers, runbook (range 4756b56..37ec7ba)
Report path: docs/ultrareview/26-08-31-pack-ship-round-1.md
Review brief SHA256: 74602cf6525381298de760026f7c9fcfb8e93050e2f0e71b3042f897b6cecde3
Scouts launched: 8
Directives: 0

## OCR Discovery Set

Scope was derived from an `ocr-review.mjs` manifest, not written by hand, so
the file set is bound to an exact SHA range and is reproducible.

| | |
|---|---|
| Base SHA | `4756b56f5cdc2e4c29733eda594848912093b856` |
| Candidate SHA | `37ec7bab507b1ae3dc3c1d7deafd6c37b767dd20` |
| Merge base | `4756b56f5cdc2e4c29733eda594848912093b856` |
| Candidate tree | `3f9ae30fa274e6884b3299a8957f3ad8092ed1af` |
| OCR version | 1.11.0 |
| Manifest digest | `sha256:d25ca59c8bc6c95b39e09062c1e91d8be5ece59213a2d80461f0eb9f8a2259f2` |
| Discovered | 41 (selected 26 + excluded 15) |

**Every discovered file is in scope for scouts — including the excluded ones.**
OCR excludes `tests/` and Markdown because they are out of scope for an
acceptance decision. They are not out of scope for a bug hunt: a fake-pass test
or a doc that contradicts the code is exactly what a scout should report. Using
OCR's *selected* set as the scout scope would silently discard
15 of 41 changed files.

| Path | OCR | Status | Exclusion reason |
|---|---|---|---|
| `config/paseo.providers.claude.example.json` | selected | modified | — |
| `config/skill-admission.json` | selected | added | — |
| `manifest.json` | selected | added | — |
| `package.json` | selected | modified | — |
| `scripts/eod-digest.mjs` | selected | added | — |
| `scripts/governance-graph.mjs` | selected | modified | — |
| `scripts/install.ps1` | selected | modified | — |
| `scripts/install.sh` | selected | modified | — |
| `scripts/policy-digest.mjs` | selected | added | — |
| `scripts/preflight.mjs` | selected | modified | — |
| `scripts/reconcile-core.mjs` | selected | added | — |
| `scripts/reconcile-observer.mjs` | selected | added | — |
| `scripts/remote-paseo.mjs` | selected | modified | — |
| `scripts/ultra-review-report.mjs` | selected | modified | — |
| `scripts/watchdog.mjs` | selected | modified | — |
| `skills/repo-refresh/agents/openai.yaml` | selected | added | — |
| `test/claude-hook.test.mjs` | selected | modified | — |
| `test/eod-digest.test.mjs` | selected | added | — |
| `test/governance-graph-assert.test.mjs` | selected | added | — |
| `test/installer-contract.test.mjs` | selected | modified | — |
| `test/policy-digest.test.mjs` | selected | added | — |
| `test/reconcile-core.test.mjs` | selected | added | — |
| `test/reconcile-qualification.test.mjs` | selected | added | — |
| `test/remote-paseo.test.mjs` | selected | modified | — |
| `test/ultra-review-report.test.mjs` | selected | modified | — |
| `test/watchdog.test.mjs` | selected | modified | — |
| `README.md` | excluded | modified | unsupported_ext |
| `docs/anti-patterns.md` | excluded | added | unsupported_ext |
| `docs/daily-ops.md` | excluded | added | unsupported_ext |
| `docs/governance-graph.md` | excluded | modified | unsupported_ext |
| `docs/multi-host.md` | excluded | modified | unsupported_ext |
| `docs/self-improve.md` | excluded | added | unsupported_ext |
| `docs/ultrareview/26-08-30-reconciler-hardening-round-1.md` | excluded | added | unsupported_ext |
| `extensions/claude-policy.mts` | excluded | modified | unsupported_ext |
| `extensions/policy-core.mts` | excluded | modified | unsupported_ext |
| `prompts/supervisor.md` | excluded | modified | unsupported_ext |
| `skills/paseo-team-lead/SKILL.md` | excluded | modified | unsupported_ext |
| `skills/paseo-ultra-review/SKILL.md` | excluded | modified | unsupported_ext |
| `skills/repo-refresh/SKILL.md` | excluded | added | unsupported_ext |
| `skills/repo-refresh/references/refresh-standard.md` | excluded | added | unsupported_ext |
| `templates/SUPERVISOR_NOTEBOOK.md` | excluded | added | unsupported_ext |

Rule groups OCR resolved for the selected set (4) are
a checklist for those files only. They are not a bound on what scouts may report.

## Prior Round Guard

Previous reports read:
- none

## Scout Roster

| Scout | Provider | Concerns | AGENT_REF | MODEL_CLASS | Read-only enforced | Status |
|---|---|---|---|---|---|---|
| scout-01 | omp/google-antigravity/gemini-3.7-flash | G01,G07 | 0ffb0100 | FAST_READ | prompt+mode (full) | submitted |
| scout-02 | omp/google-antigravity/gemini-3.7-flash | G02,G08 | 17cbf488 | FAST_READ | prompt+mode (full) | submitted |
| scout-03 | omp/google-antigravity/gemini-3.7-flash | G03,G09 | a84bb148 | FAST_READ | prompt+mode (full) | submitted |
| scout-04 | omp/google-antigravity/gemini-3.7-flash | G04,G10 | 18a906f4 | FAST_READ | prompt+mode (full) | submitted |
| scout-05 | omp/google-antigravity/gemini-3.7-flash | G05,G06 | c3ad748a | FAST_READ | prompt+mode (full) | submitted |
| scout-06 | claude-peer/claude-opus-5 (thinking high) | S01-S03 semantic A | 4c7fe5cf | REASONING_HIGH | hook | submitted |
| scout-07 | omp/google-antigravity/gemini-3.1-pro (thinking high) | T01-T03 semantic B | 7da2fc16 | REASONING_HIGH | prompt+mode (full) | submitted |
| scout-08 | claude-peer/claude-sonnet-5 | P01-P03 probe | 6e64a7c0 | FAST_READ | hook | submitted |

Count 8 (not default 10): single-repo single-commit range, 41 discovered files;
geometry per SKILL "Fleet geometry" — coverage 5 + semantic pair (2 providers) +
probe. Scaled-down reason recorded here per SKILL §Count.

## Findings

Gate columns computed via `findingAction()` (k=3), hand-checked by the Lead who
reproduced every `Reproduced: yes` on current bytes (commands in each entry).
Reproductions run 2026-08-31 post-commit 37ec7ba.

### F001 [P1] Installer ship-list has no completeness direction — eod-digest.mjs unshipped

Severity: P1 | Confidence: high
Reported by: scout-01, scout-02, scout-05, scout-06
Convergence: 4/8 | Reproduced: yes (`grep -c eod-digest scripts/install.sh scripts/install.ps1` -> 0,0) | Action: fix-eligible
Source pointer: scripts/install.sh:39-55, scripts/install.ps1:23-38, test/installer-contract.test.mjs:29-42
Evidence: TEAM_SUPPORT_FILES omits eod-digest.mjs in both installers; the script's own help and docs/daily-ops.md §5 invoke it from PASEO_TEAM_SCRIPTS_DIR; installer-contract test only asserts shipped->exists/deps, never repo->shipped (tautology that admitted this).
Contract violated: deployed pack must run its own documented daily procedure. THIRD episode of the ship-list-omission class (round-1 F006: repo-refresh + policy-digest) — promote to notebook pattern.
Failure mode: EOD step of daily runbook fails MODULE_NOT_FOUND on every installed host.
Durable solution (class-closing, per scout-06): add file to both lists AND add the reverse-direction assert — every `<PASEO_TEAM_SCRIPTS_DIR>/X.mjs` referenced in scripts/docs/prompts/skills must appear in the ship list (with an explicit not-shipped allowlist).
Trade-off of fixing now: reverse-direction test constrains future intentionally-unshipped scripts to declare themselves — small, wanted friction. None otherwise identified.
Disconfirming check: grep returns matches after fix; installer sandbox run deploys the file.

### F002 [P1] Flag set has three disagreeing owners: parser vs hook allowlist vs supervisor prompt

Severity: P1 | Confidence: high
Reported by: scout-05, scout-06 (C01+C09)
Convergence: 2/8 | Reproduced: yes (`parseArgs(['--json'])` throws USAGE; GOVERNANCE_GRAPH_SHAPE_RE allows only `all|json`) | Action: fix-eligible (contract-breaker)
Source pointer: extensions/claude-policy.mts:167-172, scripts/governance-graph.mjs parseArgs, prompts/supervisor.md:129
Evidence: the documented morning gate `--assert` is DENIED by the hook for the only hook-enforced seat with a governance-graph affordance; the sanctioned `--json` became a hard USAGE error this commit (previously ignored); docs advertise `--assert --out` composition the Supervisor is denied.
Contract violated: the flagship mechanism has no in-pack consumer allowed to invoke it; a role prompt sanctions a dead flag.
Failure mode: Supervisor morning check denied by own hook; --assert becomes a Human-only ritual outside the governed plane.
Durable solution: ONE owner for the flag set — parser exports its accepted tokens; hook regex + prompt derive/assert subset in a test. Allow `--assert` (strictly read-only); keep `--serve`/`--out` denied.
Trade-off of fixing now: widening the allowlist expands Supervisor shell surface by one read-only flag — accepted; the alternative (Human-only ritual) defeats the observe tier.
Disconfirming check: isExactGovernanceGraphCommand("node .../governance-graph.mjs --assert", dir) returns true after fix; subset test fails when parser and regex drift.

### F003 [P1] Assert tier models the world too narrowly (status-blind; provider modes unknown; role vocabulary; leadWrite ignored)

Severity: P1 | Confidence: high
Reported by: scout-04 (#2,#3,#5,#7), scout-06 (C02,C03) — 2 scouts, 6 findings, one suspected root
Convergence: 2/8 | Reproduced: yes for status-blindness (live run: A1 flagged 9 peers, ALL finished/idle from prior sessions — /tmp/assert-live.json) | Action: fix-eligible AFTER architect ruling (root-cause reopen mandatory: >=2 findings, one owning mechanism)
Source pointer: scripts/governance-graph.mjs:315-321 (writePosture), :348-356/:373-395/:428-444 (status extracted, never read), :77-83 (roleFromProvider), :140+384-390 (leadWrite)
Evidence: (a) A1/A2/A5 count posture on completed/stopped agents — a retired writer is not a moving scope; the daily correction flow (second writer on same worktree after first finishes) trips exit 3 every day. (b) writePosture returns unknown for `full`/`full-access`/`dangerously-skip-permissions` — real fleet modes degrade violations to cannotVerify. (c) roleFromProvider("omp/...") -> unknown -> A3 false-positives on the documented scout fleet while a round runs. (d) A2 reads leadWrite into message text only, never as a condition, and reads it from the COLLECTOR's env, not the lead's.
Contract violated: one-writer-per-moving-scope (invariant fires on non-signal); fail-closed inverted — manufacturing violations from non-signals teaches operators to ignore exit 3.
Failure mode: morning gate cries wolf daily; genuinely dangerous configurations (full-mode dual writers) pass as cannotVerify.
Durable solution: ARCHITECT QUESTION — one root ("assert vocabulary built claude-only, liveness ignored") or independent limbs; liveness intersection, provider-mode table, role source (labels vs provider), leadWrite condition sourced from the inspected agent.
Trade-off of fixing now: liveness filtering risks missing a wedged-but-writable agent — needs the architect to draw the live/retired line honestly (cannotVerify, not exclusion, for ambiguous states).
Disconfirming check: after fix, live assert on this repo flags 0 A1 from finished agents; fixture with two RUNNING full-mode peers on one cwd flags A1 violation.

### F004 [P1] cwd identity in governance-graph is single-spelling lexical (A1/A3 evasion; scoping casing miss)

Severity: P1 | Confidence: high
Reported by: scout-01, scout-03, scout-04, scout-07
Convergence: 4/8 | Reproduced: yes (fixture `/tmp/repo` vs `/tmp/repo/` -> 0 A1 violations) | Action: fix-eligible AFTER architect ruling (same back-edge; do NOT lexically patch per-site — AP-04)
Source pointer: scripts/governance-graph.mjs:365-381 (A1/A3 raw-string keys), :519 (scoping a.cwd only, casing leg — hardening per header comment "ls keys are lowercase")
Evidence: trailing slash / tilde / symlink spellings split one physical scope into N map keys; two write-capable peers on one directory evade A1; unknown-role agent with variant spelling evades A3. Same root CLASS the L3 cycle fixed in the reconciler — this is a NEW consumer repeating it, not a revival (both semantic seats confirmed the reconciler fix itself HOLDS).
Contract violated: A1/A3 as specified; the repo's own canonicalization-at-ingest doctrine.
Failure mode: dual-writer corruption passes the gate silently under path spelling drift.
Durable solution: ARCHITECT QUESTION shared with F003 (same file, different mechanism): canonical identity at graph ingest — reuse the reconciler's design (canonicalize once, null = cannotVerify never not-contained); scout-07 proposes importing resolveCanonicalCwds.
Trade-off of fixing now: realpath at ingest adds syscalls per agent on a hot morning path (bounded by agent count, memoizable — the reconciler already paid and measured this); lexical-normalize-only would be the cheap half-fix that re-earns AP-04.
Disconfirming check: fixture above flags 1 violation after fix; symlink pair test.

### F005 [P1] Convergence gate has no mechanical enforcement point (findingAction test-only; Trade-off parsed nowhere)

Severity: P1 | Confidence: high
Reported by: scout-06 (C05), scout-07 (#1), scout-08 (#4) — cross-provider convergence (opus + gemini-pro + sonnet)
Convergence: 3/8 | Reproduced: yes (`grep -rln findingAction scripts/ extensions/` -> only defining file; no "Trade-off" handling in any parser) | Action: fix-eligible
Source pointer: scripts/ultra-review-report.mjs:195 (zero production consumers), scripts/eod-digest.mjs:96 (parses Action, not Trade-off)
Evidence: three documents claim "computed by findingAction(), never hand-picked" — nothing computes; template emits TODO for a hand to type; the "mandatory" Trade-off line has no parser, no anomaly. docs/anti-patterns.md AP-04 row claims "mechanism (gate)" status on a test-only surface — the catalog contradicts itself on the page.
Contract violated: AP-03 (test-only production surface) + honest mechanism/rule labeling.
Failure mode: the exact round-1 failure ("3 of 12 fixes below the bar") remains fully available to an eager Lead, now with docs asserting it cannot happen.
Durable solution (scout-06's cheapest-honest, architect to confirm): eod-digest.parseReportFindings already reads the gate line — have it recompute via findingAction() and flag hand-written disagreement + missing/TODO Trade-off on fix-eligible findings as anomalies. Until then, downgrade the AP-04 wiring row to "rule".
Trade-off of fixing now: digest-side enforcement is post-hoc (catches at EOD, not at fix time) — accepted as the honest first mechanism; a pre-fix hard gate would need consolidator tooling that does not exist yet.
Disconfirming check: seed a report with Action: fix-eligible, Convergence 1/8, Reproduced no -> digest must emit anomaly after fix.

### F006 [P1] eod-digest parser/accounting leniency (one owner, six limbs)

Severity: P1 (fail-open member) | Confidence: high
Reported by: scout-01 (#1,#6), scout-05 (#1,#2,#3,#4), scout-06 (C11,C15,C20)
Convergence: 3/8 | Reproduced: yes for the two fail-open members (`applied=true` on "(not applied)"; `fix-eligible` from unchosen template "fix-eligible/record-only") | Action: fix-eligible AFTER architect ruling (>=2 findings, one owning mechanism: parser leniency)
Source pointer: scripts/eod-digest.mjs:80-116, :384-404, :424-429
Evidence: (fail-open) /\bapplied\b/i matches negative phrasing -> unapplied fix-eligible decision SUPPRESSED from digest; unchosen template token parses as chosen. (noise/accounting) underscore chop mangles cannot_verify; unreadable report still counts "scanned 4/4 - malformed 0"; filename-date never cross-checked with internal Date; --date accepts 26-99-99; pre-gate report (round-1, 25 findings, zero Action lines) floods Decisions with 25 cannot_verify entries and hits the line cap; footer prints CLAIMED manifest digest without verifying (policyDigest() is one import away); applied-table scan is table-agnostic (speculative, corpus clean).
Contract violated: fail-closed accounting — the decision surface is the one place the digest must not fail open.
Failure mode: an open fix-eligible decision vanishes from the daily decision list.
Durable solution: one parser-hardening pass with explicit token grammar (positive applied syntax only; reject unchosen/unknown as cannot_verify), source-level malformed status, pre-gate report detection (one anomaly per file, not per finding), digest verification against computed policyDigest.
Trade-off of fixing now: stricter grammar will flag legacy/hand-edited reports as anomalies — correct behavior, but the first digest after fix will be noisy once; pre-gate detection mitigates.
Disconfirming check: the two reproduced commands above return applied=false / cannot_verify after fix.

### F007 [P2] Deployed plane: policy-digest --check can never pass; attribution ritual is source-only; CI never checks drift

Severity: P2 | Confidence: high
Reported by: scout-06 (C06), scout-07 (#3)
Convergence: 2/8 | Reproduced: partially (CI yml read: no --check step; deployed-layout mismatch is structural read, not executed here) | Action: record-only (needs one deployed-host repro; then fix-eligible as contract-breaker)
Source pointer: scripts/policy-digest.mjs:24-27 vs scripts/install.sh:57-96; .github/workflows/ci.yml
Evidence: deployed layout (flat extensions, external skills, subset scripts, no templates/config) can never match the source manifest the installer copies -> --check permanently red on installed hosts, exit 1 on a fresh install; preflight.mjs is not shipped, so the morning attribution ritual runs only from source checkouts; CI runs tests + syntax but never policy-digest --check, so byte-drift merges green and install burns a stale digest into the deploy commit message.
Contract violated: "which bytes govern here" has no owner off the source checkout; audit trail lies both directions.
Failure mode: operator wires --check into health, learns to ignore permanent red; a day's artifacts attributed to bytes that were not running.
Durable solution: ARCHITECT QUESTION (shares "one owner for governed bytes" with nothing else — standalone root): deploy-time manifest regeneration (distinct deploy digest recorded alongside source digest) OR --check detects deployed root and says NOT_A_SOURCE_CHECKOUT; ship preflight; add --check to CI.
Trade-off of fixing now: a second (deploy) digest doubles the attribution vocabulary — must be labeled unambiguously or it becomes two sources of truth for governance itself.
Disconfirming check: fresh sandbox install -> deployed --check exits 0 (or NOT_A_SOURCE_CHECKOUT), never manifest_stale.

### F008 [P2] Installer git layer: .gitignore clobber, add -A over user content, -d .git defeats its own worktree guard

Severity: P2 | Confidence: high
Reported by: scout-02 (C02), scout-06 (C10)
Convergence: 2/8 | Reproduced: logic-proof (bash `[[ -d ]]` is false on a worktree/submodule `.git` FILE — the exact configuration the code comment says it guards) | Action: fix-eligible (contract-breaker: destructive overwrite class)
Source pointer: scripts/install.sh:98-124, scripts/install.ps1:72-89
Evidence: (a) `printf > .gitignore` truncates a pre-existing file, no merge; (b) `git add -A` sweeps user content into a pack-authored commit; (c) `[[ -d .git ]]` false for worktree/submodule -> `git init` re-initializes a linked repo and the commit lands in the parent's object store; ps1 uses Test-Path (file-or-dir) so the two installers diverge.
Contract violated: "before overwriting, look at the target"; installer's own stated invariant.
Failure mode: dotfiles-worktree user loses .gitignore content and gets installer-authored commits in their repo.
Durable solution: `[[ -e .git ]]` + `git -C dir rev-parse --show-toplevel == dir` guard; append state/ only if absent; commit with explicit pathspec of installer-owned files, not add -A.
Trade-off of fixing now: pathspec commit no longer snapshots user-added files in the deploy dir — that is the point, but a user relying on the old sweep loses that accidental backup; release-note it.
Disconfirming check: sandbox worktree-deploy run leaves parent repo untouched after fix.

### F009 [P1] model-routing.example.json routes REASONING_HIGH to claude-lead — escalated engineers cannot write

Severity: P1 | Confidence: high
Reported by: scout-02 (C04)
Convergence: 1/8 | Reproduced: yes (file read: example says claude-lead; cluster-routing.example + test/model-routing.test.mjs:55 say claude-peer; hook denies lead product writes) | Action: fix-eligible (one scout + reproduced contract-breaker)
Source pointer: config/model-routing.example.json:23-27
Evidence: the two example configs disagree on the same class; following the wrong one spawns escalated engineer/architect tasks as role=lead, which the hook then denies writes.
Contract violated: routing contract — REASONING_HIGH is a peer class.
Failure mode: every escalated implementation task dead-on-arrival for users who template from model-routing.example.json.
Durable solution: fix the field; add a parity assert between the two example configs for shared classes.
Trade-off of fixing now: none identified.
Disconfirming check: diff the two examples for REASONING_HIGH after fix.

### F010 [P2] Docs/config drift batch (haiku supervisor row; pi-team paths; obsolete A1-A6 draft list; stale Pi binding docs; README counts; installer echo)

Severity: P2 aggregate | Confidence: high
Reported by: scout-01, scout-02, scout-05, scout-06 (haiku row: 3 scouts)
Convergence: 3/8 (haiku member) | Reproduced: yes (haiku: config grep 1 hit = peer only; daily-ops rows 140+148) | Action: fix-eligible (haiku member); record-only (rest, batch with F002/F005 doc edits)
Source pointer: docs/daily-ops.md:140, config/paseo.providers.claude.example.json; docs/model-routing.md, docs/multi-host.md, skills/paseo-team-lead/SKILL.md, prompts/supervisor.md (pi-team); docs/anti-patterns.md:139-142; docs/claude-code.md; README.md:227; install.sh:148
Evidence: supervisor pinned to a model its own allowlist rejects; ~/.paseo-pi-team paths survive in 4+ files; anti-patterns cites a draft A1-A6 list contradicting the shipped invariants; claude-code.md references nonexistent paseo-team-policy.ts; README says 16 suites (20 exist); installer echo lists 4 of 5 skills.
Contract violated: two sources of truth per fact; runbook-vs-allowlist parity.
Failure mode: operator follows the table, gets MODEL_UNAVAILABLE on the cheapest seat.
Durable solution: haiku -> add to supervisor allowlist (monitor-only seat, cheap model is the point) + machine-parity test between daily-ops seat table and provider allowlists (scout-06's closable-class suggestion); one sweep for the rest.
Trade-off of fixing now: allowlist widening (one cheap model on an observe-only seat) — negligible; parity test adds a doc-format constraint on the seat table (worth it).
Disconfirming check: parity test red on any future drift.

### F011 [P2] Proof-debt batch: exit-3 untested at process boundary; installers never executed by the suite; "measured" claims without artifacts

Severity: P2 | Confidence: high
Reported by: scout-01 (#5), scout-08 (#1,#2,#3,#6,#7)
Convergence: 2/8 | Reproduced: yes (grep: no spawn of --assert with violation fixture; no test executes installers; `7a2ebbcc` appears once repo-wide, no artifact) | Action: fix-eligible
Source pointer: test/governance-graph-assert.test.mjs:380-405; test/installer-contract.test.mjs:315-347; skills/paseo-ultra-review/SKILL.md:53-58; README.md:7-10
Evidence: the two flagship mechanisms of this commit are proven by pure-function tests + static text asserts; the exit-3 line and the git-init sequence never execute under the suite; the SKILL's omp-probe claim ("Measured, not assumed") cites an agent id with zero committed artifact — the Lead's own P02 debt; README "measured" for bypassPermissions overstates (the property is structural: mode is never consulted).
Contract violated: AP-02 rule ("every fail-closed gate ships with a positive control through the real producer") applied to the process boundary; P02 evidence hygiene.
Failure mode: main() refactor breaks exit-3 while suite stays green; ship-list regression re-lands (F001 proved this path live).
Durable solution: PASEO_TEAM_PASEO_EXEC fixture (existing infra, no new export) driving `--assert` to real exit 3; sandbox execution test for install.sh (ps1 static until Windows CI); commit the omp probe capture under skills/paseo-ultra-review/references/; reword README.
Trade-off of fixing now: installer execution test adds ~seconds to the suite and a git dependency — gate it behind an env flag if CI minimalism matters; skipping it is how F001 happened.
Disconfirming check: mutate exit-3 line -> new test fails; delete eod-digest from ship list -> new test fails.

### F012 [P2] Error-envelope doctrine split + dead surfaces

Severity: P2 | Confidence: high
Reported by: scout-01 (#8), scout-06 (C13,C14), scout-08 (#5)
Convergence: 3/8 | Reproduced: yes (read: preflight/policy-digest emit {ok,error} on stderr; ERROR_CODES arrays zero/test-only consumers; permissionMode written never read) | Action: record-only (no contract-breaker reproduced; batch into one envelope-helper pass)
Source pointer: scripts/preflight.mjs:60-72, scripts/policy-digest.mjs:82, scripts/governance-graph.mjs:41,:735, scripts/eod-digest.mjs:22, extensions/claude-team-hook.mjs:207
Evidence: two envelope conventions ({ok,code,message}/stdout vs {ok,error}/stderr) shipped side by side; GovernanceGraphError triple-prints its code; frozen code arrays gate nothing (fail() never checks membership); permissionMode is write-only session state.
Durable solution: one failEnvelope() in lib-common; fail() asserts code membership; wire or delete permissionMode.
Trade-off of fixing now: changing preflight/policy-digest output stream is a breaking change for any wrapper reading stderr — none known in-repo, but release-note it.
Disconfirming check: contract test over all four CLIs' error output after fix.

### F013 [P2] reconcile: consumer-side null-canonical treated as "not contained" (new path AROUND the L3 rule, root itself holds)

Severity: P2 | Confidence: high (defect) / medium (reachability)
Reported by: scout-06 (C07)
Convergence: 1/8 | Reproduced: no (needs asymmetric-resolve fixture: workspace resolves, agent under it does not) | Action: record-only
Source pointer: scripts/reconcile-observer.mjs:391-394 vs :237-239 (the rule), :255-258 vs :266-279 (the asymmetry)
Evidence: agentsUnder filters `agent.canonicalCwd && isPathInside(...)` — null canonical silently drops from the set = "not contained", violating the file's own stated contract; attachCanonicalCwd (active-agents/terminals lane) emits no signal on resolve failure, unlike attachAgentCanonicalCwd. Both semantic seats independently confirmed the ROOT fix holds (no ?? raw anywhere); this is a consumer contract violation.
Durable solution: agentsUnder returns {inside, unresolved}; caller emits cwd_unresolved blocker certainty unknown for the active lane, mirroring the inspected lane.
Trade-off of fixing now: more cannot_verify noise on hosts with flaky mounts — that is the honest posture.
Disconfirming check: the fixture named above -> classification keep/cannot_verify, never candidate.

### F014 [P2] Hook bash-guard false positive: the word "commit" in a COMMENT denies COMMIT_AUTHORITY (self-observed live this round)

Severity: P2 | Confidence: medium (observed once, exact matcher line not yet located)
Reported by: scout-08 (incidental, self-observed during this round)
Convergence: 1/8 | Reproduced: live once (scout-08's read-only grep with "commit" in an echoed comment was denied) | Action: record-only (locate matcher, build repro, then fix)
Source pointer: extensions/claude-policy.mts / policy-core.mts (bash classifier)
Evidence: enforcement friction observed by the enforced seat itself; naive substring matching over command text.
Durable solution: classify on parsed command tokens, not raw substring; regression test with "commit" in comments/strings.
Trade-off of fixing now: parsing shell is hard; a tokenizer that under-matches would fail OPEN — the fix must stay conservative (deny on ambiguity) while whitelisting provably-inert positions.
Disconfirming check: `echo "# commit note"` passes; `git commit` still denied.

### F015 [P2] Role vocabulary split: harness.role labels vs provider suffix are non-composable

Severity: P2 | Confidence: medium-high
Reported by: scout-06 (C12)
Convergence: 1/8 | Reproduced: yes (read: HARNESS_AGENT_ROLES = {observer,writer,reviewer,lead,supervisor}; assert/hook key on {lead,peer,supervisor,unknown}) | Action: record-only (architect input — touches label doctrine)
Source pointer: extensions/policy-core.mts:689-695, scripts/remote-paseo.mjs:262, scripts/governance-graph.mjs:96
Evidence: `peer` inexpressible as harness.role; observer/writer/reviewer inexpressible as provider; reconciler keys on labels, asserts key on providers; neither can detect the other lying.
Durable solution: one taxonomy + explicit projection, or a consistency assert at create_agent time (data already in hand at the hook).
Trade-off of fixing now: label-schema change ripples into E2E label contract (harness.project lesson) — architect + one migration note required.
Disconfirming check: consistency assert rejects claude-lead + harness.role=observer.

### F016 [P3] Speculative/low batch (recorded, not fixed)

Reported by: scout-06 (C18 extends+disabled — settle with one live command on a scratch config; C19 skill-name exotic spellings fail-open; C20 applied-table shape risk; C21 exitCode hang risk), scout-08 (P03 env-mutation cross-file risk conditional on node --test isolation; mkdtemp leak), scout-06 incidentals (--out value validation, error-graph scope undefined, managedHistory before project filter, watchdog shim C17), scout-07 (#4 README/installer next-steps dup, #5 W-table promotion tooling), omp-worktrees-never-reconciled coverage note.
Convergence: 1/8 each | Reproduced: no | Action: record-only. C18 first — blast radius total if real, one command settles it.

## Verification Queue

- F003/F004: architect-Peer reopen (one brief, both clusters + F005 design confirm + F006 grammar) BEFORE any fix in governance-graph/eod-digest.
- F007: one sandbox install on a clean host -> run deployed --check, record exit.
- F013: asymmetric-resolve fixture (workspace resolves, agent cwd does not).
- F014: locate matcher line; minimal repro with comment-only "commit".
- F016/C18: scratch daemon config with claude disabled + extends; provider ls.
- Every fix-eligible: regression test lands WITH the fix, per pack rule.

## Coverage And Limits

TOTAL_CANDIDATES: 47 raw (8 scouts)
FINDINGS: 16 consolidated
SCOUTS_PLANNED: 8
SCOUTS_SUBMITTED: 8
SCOUTS_MISSING: none
DISCOVERED_FILES: 41
FILES_UNREACHED: skills/repo-refresh/** and config/skill-admission.json got grep-level reads only (scout-08 gap note); docs/ocr-integration.md untouched by any scout. Stated limitation, not coverage.
REVIEW_LIMITATIONS: scouts were read-only — every scout "Reproduced" claim was re-derived by the Lead on current bytes before the gate column was filled; daemon-semantics questions (C18, C02 ls -g retention) remain unexecuted; A1/A2/A3 violations FROM THE LIVE RUN include the stale prior-session agents the run itself flagged (cleanup awaiting Human).

## Fleet Geometry Measurement (the round's A1-debt payoff)

Roster: 5x gemini-3.7-flash (coverage) + semantic pair claude-opus-5 x gemini-3.1-pro + claude-sonnet-5 probe. All 8 submitted.
- Sole-source structural findings: opus-5 alone produced the two heaviest operational findings (F003 status-blindness, F007 deployed---check-never-passes) plus C07/C12/C16-class seams — 13 findings no other seat touched. Probe (sonnet) alone produced Trade-off-not-mechanized and the Lead's own uncommitted-evidence debt. gemini-3.1-pro alone produced CI---check-gap and the W-table tooling gap.
- Cross-provider convergence: F005 (gate not mechanized) was reached independently by opus, gemini-pro, AND sonnet — three seats, two providers, one root. Under this pack's doctrine that is the strongest evidence class the instrument can produce.
- Coverage fleet: produced every trivially-reproducible drift (F001 x4 scouts, F004 x4, F006, F009, F010) — exactly the sàn phủ role.
- Verdict: the two-provider geometry is QUALIFIED by measurement — semantic seats found what the flash fleet structurally could not, and the flash fleet cross-validated what single seats could not.

## Strongest Reason Not To Merge Yet

Nothing here blocks the shipped commit (37ec7ba) — the round reviewed it post-ship in the async lane, per doctrine. The strongest reason not to DEPLOY to production hosts today: F001 (EOD unrunnable installed) + F007 (--check permanently red installed) mean the DEPLOYED plane, unlike the source plane, is not yet qualified. Fix F001/F002 (mechanical, gated fix-eligible) before the next install.sh run on a real host.

## Handoff

Findings are candidates, not an acceptance decision. The Lead owns acceptance;
a human owns merge and deploy. Corrections return to the original Engineer,
who creates a new commit SHA - never an amend. Fix phase for F003/F004/F005/F006
opens with ONE architect-Peer outcome brief (counter invited) per the mandatory
back-edge; F001/F002/F008/F009/F010(haiku)/F011 are gate-passed fix-eligible with
trade-offs stated above.

