# Architect ruling — F015 role taxonomy (T-F015-ARCH, agent 671c60cb, opus-5 xhigh)

Condensed by the Lead on acceptance 2026-08-31; full text in the agent transcript.
All "(measured)" from live daemon 0.6.1, 2026-08-31T05:00-05:15Z, read-only.

## Premises handed back
- P1 partially refuted: TeamRole (policy-core, from PASEO_CLAUDE_ROLE) and
  roleFromProvider are ONE axis with two projections, mechanically linked via the
  provider config. Only HARNESS_AGENT_ROLES is genuinely disjoint.
- P2 REFUTED (load-bearing): fleet labels {scout,architect,engineer,reviewer,probe}
  = WORKSPACE_DISPOSITIONS (remote-paseo.mjs:209) under short names. F015 is a
  MISSING FIELD (no disposition slot), not vocabulary drift.
- P3 census superseded: 29 role-labeled all-time / 15 gate-compliant (exactly the
  archived peer∩owner=pct cohort) / 14 non-compliant, 9 live. Fleet 141 live / 200 all-time.
- P4: enforced enum has ONE instance in the daemon's entire history (archived reviewer).

## Q1 — taxonomy: TWO LAYERS (one-vocabulary rejected on verifiability)
- Layer 1 AUTHORITY: harness.role in {supervisor,lead,peer} — closed, = TeamRole,
  cross-checkable against provider suffix. On pack-enforced seats mismatch = A7
  VIOLATION ("the governance record disagrees with the mechanism" — never "wrong
  authority"). On unenforced/unknown providers the label is a CLAIM accepted for
  INCLUSION in the audited population, never authority; false claim fails safe
  (adds scrutiny); omission is covered by the residue clause.
- Layer 2 METHOD: harness.disposition in WORKSPACE_DISPOSITIONS. Never consulted by
  any authority gate. Creation-time only; never a second source for SKILL_ADMISSION.
- V3 brief stays source of truth; labels are its daemon-side projection.
- Closed set is a DAEMON PROPERTY: label channel has exact-match/AND/last-wins,
  NO negation, NO existence query; key-only selector fails open (returned all 200).
  "Unknown role?" is only answerable as scoped − union(role=v) over a CLOSED set.
- Hand-made suffixes (omp-peer): suffix-as-claim, never suffix-as-mechanism —
  agreement proves nothing, disagreement = cannotVerify.

## Q2 — enforcement ranking
1. governance-graph label sweep — MECHANISM, ranked FIRST. Decisive measurement: the
   reconciler's cohort is gated on harness.owner, which all 9 offenders omitted →
   invisible to it; the graph scopes by canonical cwd and contains all 9 today.
   Code shape: inherit reconcile-observer.mjs:463-499 verbatim (per-value ls --label,
   membership sets, rolesKnown all-queries-succeeded gate, validateLabelSelector).
   Cost: 3 values + base = 4 fixed spawns.
2. Reconciler labels_invalid — mechanism for the MANAGED cohort only; not the owner.
3. Create-time gate — binds by CREATOR: claude-lead seat creating an omp child DOES
   hit it. Coverage = children of armed seats = a configuration choice; currently 0%.
4. Daemon-side — unavailable, record-only (R2 upstream request: existence/negation
   selectors + reject key-only).
5. SKILL discipline — RULE; produced the 14 non-compliant agents; never count it.

## Q3 — migration: SCHEMA EPOCH, no backfill
- updateAgentLabelsBlockReason stays untouched — relabeling 140 agents from an
  unarmed session = laundering history through the hole being closed. RULED OUT.
- Epoch = recorded ISO constant vs inspect.CreatedAt (absolute, measured). ls
  carries only relative time; harness.schema=v2 ships as positive marker but MUST
  NOT be the epoch test (unlabeled agents have no marker).
- Pre-epoch agents: DECLARED cohort, one cannotVerify per scope, never violation.
- RESIDUE CLAUSE (the teeth): in governed canonical scope AND CreatedAt > EPOCH AND
  absent from every role=v result -> VIOLATION.
- Inspect failure -> cannotVerify (R1: one transient Agent-not-found observed live).

## Q4 — why the gate did not fire
All 9 evaders have ParentAgentId = a BARE-claude Paseo agent (unarmed provider,
PASEO_CLAUDE_ROLE unset, hook passive). The gate binds exactly what it can: tool
calls from seats the pack armed. Unarmed-creator set is open and always non-empty
(human window, bare claude, omp seat, GUI, CLI) -> create-time gate is seat-local
FOREVER; detection owns the fleet-wide guarantee permanently.
PROMOTED PREREQUISITE: run the standing Lead on claude-lead — one config line,
converts gate coverage from 0% to every child the Lead spawns (omp included).

## A1-teeth plan
Source role from harness.role (sweep) with provider suffix as cross-check. The live
fleet IS the positive control: 6 omp seats, Mode=full (write), same canonical scope,
labeled scout. Killing test (named): two RUNNING unenforced same-scope peers ->
exactly 1 A1 violation, exit 3 — retires the synthetic control; update all three
vacuum prose sites (anti-patterns, governance-graph.md, STATED VACUUM comment) in
the SAME change. Companions: rolesKnown fail-closed twin; selector-shape guard
(malformed selector THROWS, never queries); residue clause test (post-epoch
unlabeled -> violation; pre-epoch -> per-scope cannotVerify); A7 asymmetry test
(claude-peer+role=lead -> violation; omp+role=lead -> cannotVerify); -g/-a posture
alignment between base list and label queries, intersect by id.

## E3 scope (ONE writer, approved this cycle)
OWNS: extensions/policy-core.mts (HARNESS_AGENT_ROLES -> authority triple;
harness.disposition validation; harness.schema=v2; DO NOT touch
updateAgentLabelsBlockReason), scripts/remote-paseo.mjs (LIFECYCLE_ROLES duplicate
-> import single owner; WORKSPACE_DISPOSITIONS shared), scripts/governance-graph.mjs
(sweep, A1 re-source, A7, residue, epoch), scripts/lib-common.mjs (only if selector
validator moves), tests (claude-hook, governance-graph, remote-paseo, lib-common),
docs (governance-graph.md, anti-patterns AP row, TASK_BRIEF_V3, team-lead SKILL).
EXCLUDED: reconcile-observer.mjs (read pattern, no edit), updateAgentLabelsBlockReason,
manifest.json (Lead), any live-agent relabeling, test/governance-graph-assert.test.mjs
edits that weaken existing killing tests.
One vocabulary owner: both closed sets live in policy-core.mts; importers import;
a test asserts no second literal copy exists (skill-admission parity pattern).

## Record-only
R1 transient inspect failure (design consequence: role from ls --label, not inspect).
R2 upstream selector request. R3 probe = repository-scout variant, no 6th disposition.
R5 A3 advisory text goes stale when roles are label-sourced — rewrite in E3's docs scope.

## Lead acceptance
Accepted in full 2026-08-31. The prerequisite (standing Lead on claude-lead) is
recorded for the Human — this terminal session cannot re-provider itself; every
future standing Lead seat dispatches as claude-lead.
