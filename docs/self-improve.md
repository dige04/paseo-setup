# Self-improve loop — wiring

Maturity: **candidate**. The loop's parts exist and are wired below; no cycle has completed
end-to-end yet, so do not cite this document as evidence the harness improves itself.

The loop closes the gap the AXI survey found nobody closes: `backpass` updates without
measuring; `no-mistakes/internal/eval` measures without updating. Here every stage names the
mechanism that already exists in this repo.

```
  EVIDENCE                    ANALYZE                     PROPOSE            APPLY + MEASURE
┌─────────────────────┐   ┌──────────────────────┐   ┌───────────────┐   ┌──────────────────┐
│ supervisor notebook │   │ vendor/better-harness │   │ proposals w/  │   │ human merge only │
│ (templates/…)       │──►│ evidence-bounded      │──►│ int-02 Q5     │──►│ policy_digest    │
│ anti-patterns.md    │   │ findings; missing     │   │ gates         │   │ attributes every │
│ ultrareview reports │   │ evidence stays        │   │               │   │ episode to exact │
│ OCR manifests       │   │ explicit              │   │               │   │ governing bytes  │
└─────────────────────┘   └──────────────────────┘   └───────────────┘   └──────────────────┘
```

## The parts

**Evidence (exists).** `templates/SUPERVISOR_NOTEBOOK.md` (append-only episodes, 4-bucket
classification), `docs/anti-patterns.md` (promotion target for `role_global` patterns only),
`docs/ultrareview/*` reports, OCR manifests. Every artifact now carries `policyDigest` from
`node scripts/preflight.mjs --version`, so a failure is attributable to the exact policy bytes
that were running — the precondition for measuring any change.

**Analyze (vendored).** `vendor/better-harness` (MIT, QoderAI). Run it through Claude Code per
its README host adapter; it keeps three evidence domains separate until unified analysis and
its findings stay evidence-bounded — *"unobserved behavior stays explicit instead of becoming
an unsupported score."* Use it on demand or as the Tier-2 analyzer of the EOD digest; it
**proposes, never applies** — same posture as this pack.

**Search substrate (installed).** `semble` (`uv tool install semble`) — sub-second semantic
code search, ~95% fewer tokens than grep+read on this repo (measured via `semble savings`).
Use it for scout/review lanes and for the analyzer's code lookups:
`semble search "<question>" <repo-root>`. It is a lookup tool, not evidence: search hits are
leads, findings still need `file:line` verification.

**Propose → apply gates (rules, enforced by review).** From `research/axi/int-02` Q5, all
of which are checkable in review: citations re-resolve (`{path, offset, sha256}`);
corroboration ≥2 distinct days or cwds; exposure population re-creatable (if you cannot define
who the change helps, you cannot measure it, so you may not apply it); change class derived
from the measured diff, not the model's label; ≤3 changes per cycle; **human merge,
non-negotiable**. Measurement never gates or steers proposal generation (one-way dependency).

**Measure + revert (mechanism).** The pack is a git repo; the deployed-config side
(`~/.paseo-claude-team/`, provider config) still needs its own local git repo — until then a
routing change is not revertable by `git revert` and stage 4 of the loop is incomplete for
that class. `manifest.json` + `scripts/policy-digest.mjs --check` make drift visible; a
regressed change is **proposed** for revert, never auto-reverted.

## Vocabulary — what the Supervisor actually moves

**Knowledge** (what the model already knows) · **Context** (what it currently sees) ·
**Attention** (what it prioritizes inside that context) · **Search strategy** (how it
explores the solution space). Most coordination failures in the notebook are *attention*
failures, not knowledge failures: the agent knew the anti-pattern and did not attend to
it. The Supervisor's product is therefore **attention reallocation** — a steer at the
right moment — not added instructions. Prefer the smallest correction in the narrowest
owning surface over a new rule: a rule added for an attention failure taxes every future
context to fix one moment. (Source: vhlam, `research/doctrine/02-vhlam-distill.md` §3
S9 — adopted as vocabulary, not as a measured mechanism.)

## Standing rules (from lived episodes, not theory)

- **AP-02 rule:** every fail-closed gate ships with a positive control through the real
  producer (`test/reconcile-qualification.test.mjs` is the reference). A "0 findings" run from
  a gate without one is not evidence.
- **Empty is a first-class output.** The analyzer must be able to say "nothing new" without a
  mandate to produce findings — an empty week plus a reporting mandate manufactures root
  causes (int-02).
- **One model's self-report is never enough** to enter the notebook as fact; require command
  receipts, artifacts, or a repeated episode.
- Promotion: `role_global` bucket only. A `repo_local` quirk promoted into this pack is how
  N projects inherit one project's mistake.
- **Digest style (spec for the EOD digest when it lands):** decision-oriented, omit routine
  healthy status. A digest that reports health gets read once, then never; one that surfaces
  only decisions and anomalies keeps its reader. Pairs with "empty is a first-class output" —
  a quiet day produces a *short* digest, not a padded one.

  Tier-1 of this digest is implemented: `node scripts/eod-digest.mjs --workspace <repo-root>
  [--date yy-mm-dd] [--json] [--out <path>]` deterministically assembles the day's
  ultra-review findings, notebook escalations, commit subjects, and policy-digest attribution
  into exactly that shape — sections render only when non-empty, missing sources are reported
  in the accounting footer instead of silently skipped, and unfilled `Action:`/`Escalation
  needed:` fields surface as `cannot_verify`, never as pass. Tier-2 (analysis) remains
  `vendor/better-harness` above.
