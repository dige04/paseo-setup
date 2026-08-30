# Daily ops runbook — claude + omp/gemini stack

Operational checklist for shipping many PRs/day on exactly two providers:

- **claude** — roles `claude-supervisor` / `claude-lead` / `claude-peer`;
  authority is **hook-enforced**, fail-closed, holds under `bypassPermissions`
  (`docs/claude-code.md`).
- **omp** — restricted to `google-antigravity` gemini models; read-only is
  **prompt+mode enforced only** — the hook is passive without
  `PASEO_CLAUDE_ROLE` (`docs/review-instruments.md`). Dispatch omp scouts in
  mode `full`; mode `write` causes permission storms — every edit becomes an
  approval ceremony (W09, `templates/SUPERVISOR_NOTEBOOK.md`; round-1 routing
  note, `docs/ultrareview/26-08-30-reconciler-hardening-round-1.md`).

Every rule below cites its owning doc. Anything marked *(operating default)*
is an owner-changeable choice, not doctrine.

## 1. Morning (5 min)

- [ ] Daemon up: `paseo status` (routing cycle step,
      `skills/paseo-team-lead/SKILL.md`).
- [ ] `node scripts/preflight.mjs --version` — record `policyDigest` so every
      artifact produced today attributes to the exact governing bytes
      (`docs/self-improve.md`). Run full `preflight.mjs` after any install or
      config change (`docs/model-routing.md`).
- [ ] One reconcile pass, observation-only:
      `node scripts/watchdog.mjs '{"mode":"daily-reconcile","project":"<id>","includeOrphans":true}'`
      — the report carries `mutates:false`; cleanup candidates are requests
      for human review, never archive authority
      (`skills/paseo-team-lead/SKILL.md`).
- [ ] `node scripts/governance-graph.mjs --assert` (A1–A6 invariants + exit-code
      contract in `docs/governance-graph.md` §Assert mode). **Exit 3 = topology
      violation — fix before dispatching anything.** Two writers on one scope
      or a reviewer sharing an engineer's worktree invalidates the day's
      evidence, not just one task.

## 2. Dispatch

- One Lead per project (`skills/paseo-team-lead/SKILL.md`).
- Every authority-bearing prompt carries a **full V3 brief** — authority never
  carries across turns; follow-ups via `send_agent_prompt` must re-supply the
  whole block, and write mode never survives from a previous turn
  (`skills/paseo-team-lead/SKILL.md`).
- **One writer per moving scope, always**; racing writers get separate git
  worktrees (`skills/paseo-team-lead/SKILL.md`).
- Writer default `claude-peer` / `claude-sonnet-5` as `CODING_MEDIUM`;
  escalate to `claude-opus-5` as `REASONING_HIGH` for lifecycle, ownership,
  concurrency, migration, security design *(operating default; classes from
  `skills/paseo-team-lead/SKILL.md`)*. Record every routing decision verbatim.
- Briefs are **outcome-level**: disposition (engineer / reviewer / architect)
  changes method and `MODEL_CLASS`, never scope or authority
  (`skills/paseo-team-lead/SKILL.md` routing; `docs/anti-patterns.md` AP-04
  action — a pre-solved brief makes the Peer a confirmation function).

## 3. Per-PR critical path (blocks merge)

- [ ] Exact-SHA OCR review + independent reviewer as a **fresh** `claude-peer`
      (`DISPOSITION: independent-reviewer`, `REVIEW_HIGH`) in a fresh worktree
      at the candidate SHA — never the engineer's worktree
      (`skills/paseo-team-lead/SKILL.md`; `docs/ocr-integration.md`).
- [ ] Reviewer returns `PASS` / `CHANGES_REQUIRED` / `BLOCKED` and holds no
      acceptance authority; the Lead owns acceptance, the Human owns merge
      (`skills/paseo-team-lead/SKILL.md`; `docs/review-instruments.md`).
- [ ] Corrections return to the **original** Engineer with a full V3 brief
      (write authority re-granted); the Engineer produces a **new commit
      SHA — never amend, never force-push**
      (`skills/paseo-team-lead/SKILL.md`; `skills/paseo-ultra-review/SKILL.md`
      Handoff).
- [ ] Lifecycle status is never acceptance: `completed`, `idle`, exit 0, or a
      label proves nothing; no `done` labels exist — accepted sessions are
      archived instead (`skills/paseo-team-lead/SKILL.md`). Unknown is never
      pass: an unverifiable agent is `cannot_verify`, not clean.

## 4. Async lane (never blocks merge)

Ultra review is a recall instrument, not acceptance — a quiet sweep is not a
`PASS` (`docs/review-instruments.md`). Run it per **module** on accumulated
change, on a schedule the merge queue never waits for.

- Geometry (`skills/paseo-ultra-review/SKILL.md` fleet geometry; model picks
  are *operating defaults* verified at dispatch):
  - **Semantic pair** — two `REASONING_HIGH` scouts on two different
    providers: `claude-peer`/`claude-opus-5` ×
    `omp/google-antigravity/gemini-3.1-pro`; independently briefed, never
    seeded with each other's output.
  - **Coverage fleet** — `FAST_READ` majority on
    `omp/google-antigravity/gemini-3.7-flash` (mode `full`).
  - **Probe** — one `claude-peer` scout; round-1 calibration showed a single
    second-provider probe sourced findings the whole fleet missed
    (`docs/ultrareview/26-08-30-reconciler-hardening-round-1.md`).
  - Hard rule: no model holds ≥90% of seats; span ≥2 providers, record the
    split in the roster (`skills/paseo-ultra-review/SKILL.md`).
- Scaffold the one report with `scripts/ultra-review-report.mjs`; settle who
  writes it **before** dispatching scouts (`docs/review-instruments.md`).
- **Convergence gate** before any fix
  (`skills/paseo-ultra-review/SKILL.md`): `Action` is computed by
  `findingAction()`, never hand-picked —
  `fix-eligible ⇔ Reproduced AND (Convergence ≥ 3 OR contract-breaker)` —
  **and** the `Trade-off of fixing now` line must be written out ("none
  identified" explicit, never implied) before a fix-eligible finding is
  applied. `record-only` is not rejection; it queues for verification or
  round 2.
- **≥2 findings sharing one owning mechanism → architect-Peer reopen BEFORE
  fixing any of them** — outcome-level brief, `REOPEN_WHEN`, explicit
  permission to counter the Lead's grouping
  (`skills/paseo-ultra-review/SKILL.md`; `docs/anti-patterns.md` AP-04).

## 5. EOD (5 min)

- [ ] `node scripts/eod-digest.mjs --workspace .` (spec in
      `docs/self-improve.md` §Digest style): decision-oriented, omits
      routine healthy status. **A quiet day produces a short digest, not a
      padded one** — empty is a first-class output.
- [ ] Notebook entries only for **causal patterns**, not activity; one
      model's self-report never enters as fact — require command receipts,
      artifacts, or a repeated episode (`docs/self-improve.md`;
      `templates/SUPERVISOR_NOTEBOOK.md`).

## 6. Escalation

| Returns to the Human | The Lead resolves |
|---|---|
| Merge, push, deploy, anything irreversible (`prompts/supervisor.md`) | Acceptance of a candidate (`skills/paseo-ultra-review/SKILL.md` Handoff) |
| Authority/delegation expansion — never self-granted (`prompts/supervisor.md`) | Routing decisions within the routing contract (`skills/paseo-team-lead/SKILL.md`) |
| Cross-project changes; promotion into the pack needs `role_global` + ≥2 distinct-project episodes + human merge (`docs/anti-patterns.md`; `docs/self-improve.md`) | Scout count 4–10 and fleet geometry, with reasons recorded (`skills/paseo-ultra-review/SKILL.md`) |
| Catalog policy: projects may disable entries, never add them (`docs/anti-patterns.md`) | Convergence-gate outcomes and the architect reopen dispatch (`skills/paseo-ultra-review/SKILL.md`) |
| `REDIRECT_RECOMMENDED` / `STOP_AND_REDIRECT` premise verdicts — always `HUMAN_DECISION_REQUIRED: yes` (`docs/review-instruments.md`) | Correction rounds back to the original Engineer (`skills/paseo-team-lead/SKILL.md`) |
| Repeat offenders — a second fix of the same failure escalates (`prompts/supervisor.md`) | Report consolidation arrangement (consolidator Peer vs Lead write) (`docs/review-instruments.md`) |

## 7. Provider quick-reference

Seat models below are *operating defaults*. Model IDs drift; the routing
cycle re-verifies every seat at dispatch — exact `provider/model` string,
pre-validate via `list_models`, post-verify observed `runtimeInfo`, and
`MODEL_RESOLUTION_MISMATCH` / `STARTUP_IDENTITY_UNAVAILABLE` are blocks, never
fallbacks (`docs/model-routing.md`).

| Seat | Provider/model | Thinking | Mode | Enforcement |
|---|---|---|---|---|
| Supervisor | `claude-supervisor` / `claude-haiku-4-5` | low | monitor-only | hook (`docs/claude-code.md`) |
| Lead | `claude-lead` / `claude-opus-5` | high | orchestrate, no product writes | hook (`docs/claude-code.md`) |
| Writer (default) | `claude-peer` / `claude-sonnet-5` | medium | write via V3 brief only | hook (`docs/claude-code.md`) |
| Writer (escalation) | `claude-peer` / `claude-opus-5` | high | write via V3 brief only | hook (`docs/claude-code.md`) |
| Independent reviewer | `claude-peer` / `claude-opus-5` | high | read-only, fresh worktree | hook (`docs/claude-code.md`) |
| Semantic-pair (claude) | `claude-peer` / `claude-opus-5` | high | read-only | hook (`docs/claude-code.md`) |
| Semantic-pair (gemini) | `omp/google-antigravity/gemini-3.1-pro` | n/a | `full` — never `write` | prompt+mode only (`docs/review-instruments.md`) |
| Coverage fleet | `omp/google-antigravity/gemini-3.7-flash` | n/a | `full` — never `write` | prompt+mode only (`docs/review-instruments.md`) |
| Cheap probe | `claude-peer` / `claude-haiku-4-5` | low | read-only | hook (`docs/claude-code.md`) |
