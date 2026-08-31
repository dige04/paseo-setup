# Self-improve cycle 1 — better-harness bench, proposals through Q5 gates

First end-to-end run of the loop wired in `docs/self-improve.md`:
evidence bundle (3 lanes, all available, target this repo, window 26-08-28..31)
→ 3 isolated evidence agents (12 candidates) → lead reconciliation →
6 findings (`.claude/better-harness/report.html`, findings.json alongside)
→ THIS document: ≤3 proposals, each with its Q5 gate status stated honestly.
**Human merge is non-negotiable — nothing below is applied.**

Analyzer facts: session population EMPTY for this workspace key (verified
cause: real sessions live under the parent directory's key; window also froze
at 00:00Z of the bench day). Asset inventory resolved 0 project-scope
rules/skills/hooks while the manifest governs 45 files (pack assets are
user-scope by install design + no AGENTS.md). Both boundaries are stated in
the report rather than inferred around.

## Proposals (3 of 6 findings; the other 3 recorded in findings.json)

### P1 — AGENTS.md at the pack root  (finding: self-repo-agent-entrypoint, Medium)
The repo that governs agents gives an agent editing IT no machine-readable
entrypoint: no AGENTS.md/CLAUDE.md, provider resolves 0 rules at project scope,
and `paseo-team-lead`'s own preflight looks for AGENTS.md "if present" and
finds nothing. Content: core/companion sync map, canonical commands
(npm test · typecheck · policy-digest --check · check-report-gates), the
manifest-refresh rule, pointers to daily-ops + anti-patterns.
Q5 gates: citations ✅ (ls-files + inventory, re-resolvable) · corroboration
⚠️ 2 independent lanes but ONE day/cwd — below the ≥2-days bar, stated ·
exposure population ✅ (every future session editing this repo) · change class
✅ docs-only · human merge pending.

### P2 — Govern ci.yml inside the digest perimeter  (finding: ci-outside-digest-perimeter, Medium)
ci.yml carries the only pre-merge gates (test, --check, report-gate) and is
NOT in the manifest: weakening the gates leaves --check green. Add it to
GOVERNED_FILES + manifest refresh + a one-byte-mutation assert in
test/policy-digest.test.mjs.
Q5 gates: citations ✅ (manifest.json vs GOVERNED_FILES, re-resolvable) ·
corroboration ⚠️ customize-lane + round-1 scout-07 (F007 CI limb) — two
independent seats, one day · exposure ✅ (every PR) · change class ✅
config+test · human merge pending.

### P3 — Behavioral test for preflight.mjs  (finding: preflight-no-behavior-test, Medium)
~865-line readiness surface protected only by `node --check`; the CI comment
admits it in writing. New test/preflight.test.mjs: spawnSync probes of
--version / unknown-flag / missing-value routes, each with recorded
mutate-and-fail evidence.
Q5 gates: citations ✅ · corroboration ✅ CI comment predates the bench day +
today's lane observation = two distinct days · exposure ✅ (every install and
morning ritual) · change class ✅ test-only · human merge pending.

## Recorded, not proposed this cycle (≤3 rule)
- session-evidence-boundary (Medium) — runbook note: bench with the
  session-bearing workspace and an until past the bench day; no single target
  currently serves both the session lane (parent dir) and the git lane (this
  repo). Candidate for the next daily-ops edit.
- gate-marker-not-required-forward (Low) — date-cutoff in check-report-gates.
- duplicated-governed-references (Low) — parity assert for the twin reference
  files across the two review skills.

## Loop accounting
Bundle: complete, 3/3 lanes + lead. Agents: exactly 3 (skill hard cap).
Findings: 6 (5 dimension scores under evidence ceilings; Learning Capture 40 —
zero observed episodes is the honest floor driver). Render: --validate pass.
Proposal cap: 3/3 used. Apply: none (human gate). Measurement of any applied
proposal happens against policyDigest attribution per docs/self-improve.md.
