---
name: paseo-ultra-review
description: Run a maximum-recall parallel bug hunt as Lead by dispatching independent read-only scout Peers with deliberately overlapping concerns, then consolidate every candidate into one durable report. Use when the user asks for an ultra review, a maximum-recall bug hunt, or a broad parallel review of a scope.
---

# Paseo Ultra Review — Lead coordinator

Load this skill **as the Lead**. It dispatches scout Peers through Paseo; it is
not a Peer skill and never runs inside a scout. A Peer that finds itself reading
this skill has been mis-briefed — report `AUTHORITY_MISMATCH`.

This is a **recall** instrument, not an acceptance instrument. It answers "what
might be wrong here", deliberately over-reporting. It does not answer "is this
candidate correct" — that is verification, which happens later, and it does not
answer "is this commit acceptable" — that is `paseo-ocr-reviewer`, which is
exact-SHA bound and deterministic. Running ultra review does not satisfy the
independent review step in `paseo-team-lead`, and a `PASS` there is not implied
by a quiet ultra review here.

## Goal and non-goal

Maximize bugs discovered. False positives and noise are acceptable. **Never**
drop a candidate from the artifact because it is speculative, unique,
low-confidence, weakly evidenced, duplicated, or hard to classify. Suppression
at consolidation time is unrecoverable; rejection at verification time is
recorded and reversible.

Non-goal: fixing anything. This skill produces exactly one report and no other
change.

## Authority — read before dispatching

| Actor | May | May not |
|---|---|---|
| Lead (you) | dispatch scouts, consolidate, write the one report | edit product code, accept, merge |
| Scout Peer | read, search, reason, report candidates | edit, stage, format, commit, run tests/builds/package managers, create agents |

Every scout brief is `MODE: read-only`, `EDIT_AUTHORITY: denied`,
`COMMIT_AUTHORITY: denied`, `PUSH_TASK_BRANCH_AUTHORITY: denied`. The extension
enforces this fail-closed; the brief must still state it, because a brief that
relies on the extension to say no is a brief that says nothing.

Scouts perform **static read-only inspection only**. No tests, builds, package
managers, proof commands, or task runners — a scout that runs the suite is
producing evidence about an implementation, not recall about a defect, and it
mutates timestamps and caches inside a workspace another agent may own.

## Deriving scope from OCR — preferred

When the review is a commit range, do **not** describe the file set by hand.
Run the OCR wrapper first and feed its manifest to the scaffold:

```text
git worktree add --detach <review-worktree> <candidate-sha>

node <PASEO_TEAM_SCRIPTS_DIR>/ocr-review.mjs \
  --repo <review-worktree> --base <base-sha> --candidate <candidate-sha> \
  > <manifest-path-outside-the-worktree>

node <PASEO_TEAM_SCRIPTS_DIR>/ultra-review-report.mjs \
  --workspace <repo-root> --review-name <slug> --scope "<change intent>" \
  --review-brief-sha256 <sha256> --scout-count <n> --directive-count <n> \
  --ocr-manifest <manifest-path>
```

This buys three things a hand-written scope cannot: the file set is bound to an
exact SHA range, the manifest digest makes the round reproducible, and the
discovery is OCR's rather than the Lead's recollection.

Write the manifest **outside** the reviewed worktree — creating it inside
correctly trips OCR's own dirty-workspace gate.

### OCR's exclusions do not apply to scouts

The scaffold embeds OCR's **discovery** set — selected *and* excluded — and
every discovered file is in scope for scouts.

OCR excludes `tests/` (`default_path`) and Markdown (`unsupported_ext`) because
they are out of scope for an *acceptance decision*. They are squarely in scope
for a *bug hunt*: a fake-pass test, a fixture asserting its own output, or a doc
that contradicts the code is exactly what `references/proof-debt-catalog.md`
hunts. On a real agy-acp range, OCR selected 5 of 14 changed files — taking the
selection as the scout scope would have discarded all five test files.

So: never pass OCR's `reviewable_files` as the scout scope. Pass the full
discovery set, and tell scouts which files OCR excluded and why — the reason
informs how hard to look, it does not remove the file.

The resolved rule groups are a checklist for the selected files only. They are
never a bound on what a scout may report.

### Report `FILES_UNREACHED`

With a manifest, the report gains `DISCOVERED_FILES` and `FILES_UNREACHED`.
Account for every discovered file: any that no scout inspected is a stated
limitation. Recall means knowing what was not looked at.

## Scout allocation

### Count

Default **10** scouts. The Lead may scale down for a genuinely small scope
(a two-file diff does not need ten independent traces) but must record the
actual number and the reason in the report's `Scout Roster` and
`SCOUTS_PLANNED`. Never scale below **4** — below that, overlap stops producing
cross-validation and the artifact becomes one opinion with extra steps.

Scaling up past 10 is allowed only with a stated reason. Ten concurrent Peers is
real daemon load and real cost; twenty is a decision, not a default.

### Concerns

If the caller supplied **no** directives:

- derive the strategy from scope, repository contracts, architecture, change
  intent, adjacent owners, call paths, lifecycle, data flow, and blast radius;
- name generated concerns `G01`, `G02`, …;
- diversify search routes while deliberately overlapping the risky areas.

If the caller supplied directives `D01`, `D02`, …:

- every directive is **mandatory**;
- assign every directive to **at least three independent scouts**;
- expand each directive into useful search angles without weakening, narrowing,
  or replacing it.

For both modes:

- name scouts consecutively `scout-01` … `scout-NN`;
- give every scout at least one assigned concern;
- give every scout permission to report any incidental in-scope bug, even
  outside its assigned concerns;
- make overlap produce genuinely different traces, lifecycle phases, owners,
  adversarial cases, or disconfirming approaches — **not** ten copies of one
  prompt;
- preserve scout independence: do not share candidates between scouts before
  consolidation, and do not let one scout read another's report.

### Uniform prompts, diverse angles

The overlap is only worth its cost if scouts are cross-validating rather than
dividing labour. Keep the standing sections of every scout packet **identical**
— same scope, same contracts, same output contract, same permissions — and vary
only the assigned concern IDs and their tailored search angles. A scout told it
is "the performance scout" will stop reporting the memory-safety bug it tripped
over; a scout told "here are your angles, report anything else you find" will
not.

### Routing

Route scouts as `MODEL_CLASS: FAST_READ` by default — recall over depth, and
ten high-reasoning Peers is a poor trade against ten broad readers plus one
careful consolidation. Escalate specific scouts to `REASONING_HIGH` when their
concern is genuinely deep (concurrency, ownership, lifecycle, security design)
and record why in the roster. Resolve and verify every route through the normal
`paseo-team-lead` routing cycle; ultra review grants no routing shortcut.

## Scout packet

Each scout's V3 brief task body must contain:

- exact review scope and change intent;
- relevant repository contracts and prior-round warnings;
- assigned concern IDs and tailored search angles;
- explicit permission to report every incidental in-scope concern;
- instruction to inspect the full relevant production surface, not only the
  visible diff;
- required per-candidate fields: `file:line` evidence, failure mode, confidence,
  durable solution hypothesis, and a disconfirming check when one exists;
- explicit permission to return incomplete or speculative candidates rather than
  suppressing them;
- the read-only restrictions above, stated in full.

An example brief is in `examples/ultra-review-scout-task.md`.

## Search surface

Combine lenses appropriate to the scope. This is raw material for allocation,
not a fixed topology:

- semantic and state-machine correctness;
- ownership × lifecycle/event × expected-outcome gaps;
- caller/API/schema/protocol/data-format contracts;
- concurrency, ordering, cancellation, cleanup, resource lifetime;
- error masking, fallback, retry, partial failure, invariant handling;
- authorization, trust boundaries, adversarial input, abuse cases;
- hot-path allocation, copies, rescans, N+1 work, blocking, contention;
- generated artifacts, fixtures, validators, snapshots, docs, examples;
- test/proof gaps, fake-pass evidence, mocked production claims
  (see `references/proof-debt-catalog.md`);
- compatibility paths, duplicate state, wrappers, caches, and compensation for a
  broken foundation (see `references/structural-antipatterns.md`);
- owner/module boundaries, file responsibility, missing essential mechanisms;
- alternate end-to-end call traces and hostile edge cases.

When work leans on existing modules, assign the **foundation-accommodation**
lens explicitly: which local workaround exists only because a dependency does
not own something it should.

## Prior round guard

Before round 2 or later, read every earlier report with the same review name.
Give relevant scouts concise warnings about confirmed fixes, rejected false
positives, unresolved routes, and regression risks.

A prior rejection is **not** a filter. A scout may revive a rejected candidate
with or without new evidence, and the artifact must retain it. Reviewers are
wrong sometimes; a rejection list that silently prunes the next round converts
one mistake into a permanent blind spot.

## Restart recovery

A system notice that subagents or background tasks stopped due to a restart is a
**recovery trigger, not permission to restart the review from scratch**.

1. Freeze the existing logical roster, concern allocation, report path, and
   review-brief digest.
2. Inventory which logical scouts have persisted reports.
3. Preserve every completed scout report exactly once.
4. Do **not** relaunch the full batch. Revive or restart only the missing
   logical scouts, with their original assignments and routing.
5. A replacement attempt continues the same logical scout ID. Never create an
   extra logical scout and never duplicate completed work.
6. After all logical scouts complete, consolidate once into the existing report.

When resumed with a recovery prompt, inspect persisted state before taking any
launch action. A bare continuation must never create another full batch.

## Artifact contract

Create exactly one report:

```text
node <PASEO_TEAM_SCRIPTS_DIR>/ultra-review-report.mjs \
  --workspace <repo-root> \
  --review-name <slug> \
  --scope "<change intent>" \
  --review-brief-sha256 <sha256> \
  --scout-count <n> \
  --directive-count <n> \
  [--ocr-manifest <path>]
```

`--scope` stays required even with a manifest: the manifest supplies the file
set, not the change intent. A scout that knows which files moved but not what
the change was meant to achieve reviews syntax, not semantics.

The `--review-brief-sha256` is the SHA-256 of the authoritative review brief
text, so a later round can prove which brief it ran against. Compute it with
`shasum -a 256` (Unix-like) or `Get-FileHash -Algorithm SHA256` (PowerShell).

Use the script's `report_path`; never improvise or overwrite it. The script
refuses to overwrite an existing report and derives the round number from what
is on disk, so a Lead that lost context cannot silently clobber round 1.

Replace every `TODO`. If scouts submitted no candidates, write
`No candidates reported.` After writing, print the report path and full content.

The report is the only workspace artifact this skill may create.

### Write authority — check this before dispatching scouts

Consolidation edits the report file, and the Lead's `Write`/`Edit` tools are
denied by default (`PASEO_TEAM_LEAD_WRITE`). The scaffold itself runs through
Bash and will succeed, so the failure lands *after* ten scouts have already been
paid for: a scaffold full of `TODO` that cannot be filled in.

Confirm one of these **before** dispatching:

- `PASEO_TEAM_LEAD_WRITE=1` is set for this Lead and the Workspace Protocol
  permits the coordination artifact, or
- the Workspace Protocol grants `LEAD_WRITE_POLICY: allowed`.

If neither holds, stop and report `BLOCKED: LEAD_WRITE_UNAVAILABLE` rather than
dispatching. Do not route around the gate by shelling out to write the file —
the gate is the mechanism, and defeating it from Bash makes every other write
restriction in the pack advisory.

## Consolidation

1. Group every candidate into consolidated findings `F001`, `F002`, … by **root
   cause**, recording which scouts reported each. Two scouts reaching the same
   root cause by different traces is the cross-validation signal — do not
   discard the second trace, note it.
2. Preserve every unique or speculative candidate. Consolidation merges by root
   cause; it never filters by plausibility.
3. Keep each finding concise and purely actionable — severity (`P0`–`P3`),
   confidence, exact `file:line`, evidence observed, contract violated, failure
   mode, durable solution hypothesis, disconfirming check.
4. Build a verification queue containing every finding and its read-only
   disconfirming check.
5. Record `SCOUTS_PLANNED`, `SCOUTS_SUBMITTED`, and `SCOUTS_MISSING`. A missing
   scout is a stated limitation, never silent partial coverage — the report must
   not read as full coverage when a scout never returned.

Do not add raw candidate ledgers, execution receipts, preservation counters, or
merge-note checklists. The audience is an agent that must verify and fix bugs.

## Handoff

Findings are candidates. This skill produces no acceptance and no verdict on the
commit. The Lead owns acceptance, a human owns merge and deploy, and corrections
return to the original Engineer, who produces a new commit SHA — never an amend.
