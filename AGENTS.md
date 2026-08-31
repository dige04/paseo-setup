# paseo-claude-team — agent entrypoint

Governance pack for Claude Code + Paseo multi-agent work (Supervisor / Lead /
Peer). This file is the one page an agent editing THIS repo reads first.
(Bench cycle 1 finding: the repo that governs agents gave agents editing it no
machine-readable entrypoint. This is that entrypoint.)

## Canonical commands — run these, not variants

```bash
npm test                                          # every test/*.test.{mjs,mts}; must be 100% green
npm run typecheck                                 # tsc over extensions/**.mts
node scripts/policy-digest.mjs --check            # governed bytes vs manifest.json
node scripts/check-report-gates.mjs docs/ultrareview   # convergence-gate over Gate: v1 reports
node scripts/preflight.mjs --version              # {name, version, policyDigest, fileCount} — cite in artifacts
node scripts/governance-graph.mjs --assert        # topology invariants A1–A8; exit 3 = violation
node scripts/eod-digest.mjs --workspace .         # deterministic daily digest
node scripts/wake-tier.mjs                        # hung-agent scan; exit 3 = somebody must act
```

Skills are installed **per project**, never globally:
`scripts/install.sh --skills-only --project <path>` (requires that project's
`WORKSPACE_PROTOCOL.md`). See `docs/onboarding.md`.

## The one rule that catches everyone

**Any byte change under `prompts/ extensions/ skills/ templates/ scripts/`,
or to `docs/anti-patterns.md`, `config/skill-admission.json`,
`.github/workflows/ci.yml`, makes `manifest.json` stale.** Refresh with
`node scripts/policy-digest.mjs --write-manifest` — by the INTEGRATING seat
(the Lead), exactly once per merged change set, never by parallel writers.
CI runs `--check` and fails the PR on drift.

## Core ↔ companion sync map

| If you change | Also update |
|---|---|
| `scripts/governance-graph.mjs` (assert tier) | `docs/governance-graph.md` (invariants + "still cannot do"), `docs/anti-patterns.md` wiring table |
| `scripts/ultra-review-report.mjs` (gate grammar) | `skills/paseo-ultra-review/SKILL.md`, `scripts/eod-digest.mjs` consumers, `docs/anti-patterns.md` AP-04 row |
| `extensions/policy-core.mts` vocabularies (`HARNESS_ROLE_VALUES`, `SKILL_ADMISSION`) | mirrors are TEST-PINNED: `config/skill-admission.json`, `scripts/lib-common.mjs` runtime mirror — parity tests will name the drift |
| `scripts/install.sh` | `scripts/install.ps1` (line-for-line mirror), `test/installer-contract.test.mjs` |
| Any new `scripts/*.mjs` invoked from docs/skills | BOTH installers' ship lists (a reverse-direction test enforces this) |
| Review doctrine (gates, briefs, roles) | `docs/daily-ops.md` runbook rows citing it |

## Non-negotiables (mechanisms, not advice — tests will kill violations)

- **Fail-closed both directions**: unknown is never pass, and invented
  violations are equally forbidden (advisory/cannotVerify with a reason).
- **Writer ≠ acceptor**; corrections return to the ORIGINAL engineer; every
  fix lands WITH its killing test (mutate → watch it fail → restore).
- Errors: `{ok:false, code, message}` envelope + exit 2 (usage/environment);
  `governance-graph --assert` adds exit 3 = violations.
- Tests are PLAIN top-level asserts (`node:assert/strict`); some legacy files
  use `node:test` — match each file's own style, never mix.
- Scripts are TAB-indented except `governance-graph.mjs` (2-space, historic).
- Labels (schema v2): `harness.role` ∈ {supervisor, lead, peer} (authority,
  closed); `harness.disposition` ∈ the frozen five (method — NEVER authority,
  never a second `SKILL_ADMISSION` source).

## Where the rest lives

- `docs/onboarding.md` — host-wide vs per-project split; when NOT to onboard
- `docs/decisions/` — owner decisions, with the rejected options and their costs
- `docs/daily-ops.md` — the operating day (dispatch, review lanes, EOD)
- `docs/anti-patterns.md` — AP catalog + assert-tier wiring status
- `docs/ultrareview/` — review rounds + architect rulings (the decision record)
- `templates/WORKSPACE_PROTOCOL.example.md`, `templates/TASK_BRIEF_V3.md` —
  contracts for governed repos and V3 briefs
- `README.md` — install + quickstart for humans
