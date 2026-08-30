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
`COMMIT_AUTHORITY: denied`, `PUSH_TASK_BRANCH_AUTHORITY: denied`.

### Which scouts are actually enforced read-only

The V3 brief is a **contract**, not a mechanism. It is enforced only for scouts
on a `claude-peer` provider, where the `PreToolUse` hook parses the brief and
denies the tool call. Know which kind you dispatched:

| Scout provider | Read-only enforced by | Failure mode |
|---|---|---|
| `claude-peer` | `PreToolUse` hook, fail-closed, holds under `bypassPermissions` | a write is denied |
| `agy` (ACP) | **nothing in this pack** — the hook is passive without `PASEO_CLAUDE_ROLE` | a write succeeds |
| `omp` | **nothing in this pack** — prompt + session mode only | a write succeeds, **and the full Paseo control plane is reachable** (below) |

**Measured, not assumed (probe 2026-08-31, agent `7a2ebbcc`):** an omp seat sees
**zero** tools named `mcp__paseo__*` but **35 bare-named orchestration tools** —
`create_agent`, `send_agent_prompt`, `kill_agent`, `archive_workspace`,
`create_schedule`, `respond_to_permission`, … So (1) any check that filters on
the `mcp__paseo__` prefix is blind for omp seats — probe by bare name too;
(2) an omp scout that drifts off its brief *can* spawn, kill, or archive — the
brief must prohibit orchestration explicitly, every time; (3) run
`governance-graph --assert` during and after a round: invariant A4
(peer-orchestrates) is the compensating **detection** for this gap until a
daemon-level per-provider injection bound exists.

For an `agy` scout the ACP session mode is the only bound available, and the
closest fit is `plan`. Even that is a *disposition*, not a wall: agy exposes
`default`, `accept-edits`, `plan`, and `dangerously-skip-permissions`, and none
of them is a hard read-only. **Never dispatch an `agy` scout with
`accept-edits` or `dangerously-skip-permissions`** — a scout that edits while
nine others read the same tree corrupts the evidence for the whole round, and
you will not find out until consolidation.

Prefer `claude-peer` scouts when the review scope is a repository you care
about. Reach for `agy` scouts to add model diversity — a genuinely different
model finds genuinely different bugs, which is the point of overlap — and
accept that their read-only status rests on the mode plus the prompt. Say which
providers you used in the Scout Roster so a reader can weight the guarantee.

State the restrictions in the brief regardless of provider. For `claude-peer`
the brief is what the hook parses; for `agy` the brief is the only thing there
is.

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

**Model diversity is worth more here than in any other instrument.** Ten scouts
on one model share that model's blind spots, so overlap re-confirms what it
already sees and misses the same things ten times. Mixing providers — some
`claude-peer`, some `agy` — buys genuinely independent traces. Weigh that
against the enforcement table above: an `agy` scout's read-only status rests on
its ACP mode and its prompt, not on the hook. Record each scout's provider in
the roster so the guarantee is visible rather than assumed.

### Fleet geometry — providers are the unit of diversity

Round-1 calibration data made the previous paragraph a rule: nine scouts on
one model plus one probe on a second provider, and the single probe was the
sole source of three of the round's second-order findings. One model's blind
spots are correlated — a second provider is not more of the same, it is a
different instrument.

Default geometry for a full round:

- **Coverage fleet** — the `FAST_READ` majority. Cheap, broad,
  roster-accounted; owns the coverage floor, not the deep calls.
- **Semantic pair** — exactly two `REASONING_HIGH` scouts on two **different**
  providers, same scope, independently briefed, never seeded with each other's
  output. Their disagreement at consolidation is signal, not friction to
  resolve early.
- **Probe** — one scout on a third provider when one is available, briefed
  like any other scout.

Hard rule: a fleet where one model holds ≥90% of the seats re-confirms what
that model already sees and re-misses what it misses, N times over. Span at
least two providers and record the split in the roster. Verify each seat's
model through the normal routing cycle — the geometry names classes, not
model IDs.

#### Default mapping — the two-provider stack this repo runs

Verified live against the daemon on 2026-08-31. Standing rule regardless:
**every seat is re-verified through the routing cycle at dispatch time** —
model IDs drift, and this mapping is a default, not a bypass of that cycle.

- **Semantic pair** — `claude-peer`/`claude-opus-5` (thinking `high` or
  `xhigh`) × `omp/google-antigravity/gemini-3.1-pro` (thinking `high`).
  Two strong models, two providers.
- **Coverage fleet** — `omp/google-antigravity/gemini-3.7-flash`, omp session
  mode `full`. Round-1 lesson: mode `write` gates every bash call into a
  permission storm; enforcement for omp seats is prompt+mode, not the hook.
- **Probe** — one `claude-peer` seat (hook-enforced read-only guarantee).
  With a two-provider stack the semantic pair already spans both providers,
  so the probe's job here is the enforcement guarantee, not extra diversity.

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
- the standing instruction: **do not stop after the first finding, and do not
  silently omit difficult or large files** — name every file skipped and why;
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

### Who writes the report — check before dispatching scouts

Consolidation edits the report file, so establish **before** spending scouts
that someone can actually write it. Two working arrangements:

**A. A consolidator Peer writes it (default, no Lead write needed).** After the
scouts return, brief one more Peer with `MODE: write`, `EDIT_AUTHORITY:
allowed`, `COMMIT_AUTHORITY: denied`, and `OWNED_SCOPE` set to the single report
path the scaffold printed. Hand it the scout reports and the consolidation rules
below. This keeps the Lead read-only, which is the pack's default posture, and
keeps the write bounded to one file by an owner that is not also the dispatcher.

**B. The Lead writes it directly.** Requires `PASEO_TEAM_LEAD_WRITE=1` on the
Lead provider, or `LEAD_WRITE_POLICY: allowed` in the Workspace Protocol.
Simpler, but it grants the Lead `Write`/`Edit` on *every* file for the whole
session, not just the report — the hook has no per-path bound.

The trap either way: the scaffold runs through Bash and **succeeds**, so an
unresolved write path fails only at consolidation, after every scout has been
paid for. Verify the arrangement first; if neither holds, report
`BLOCKED: REPORT_WRITER_UNAVAILABLE` instead of dispatching.

Do not route around a denied write by shelling out to create the file. The gate
is the mechanism, and defeating it from Bash makes every other write restriction
in the pack advisory.

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
6. Do not spend a reviewer reconfirming a proof that is already recorded.
   Re-review needs **material uncertainty** — an uncovered site, a failed
   repro, a contested mechanism — not ceremony. Point the next reader at the
   recorded evidence instead.

Do not add raw candidate ledgers, execution receipts, preservation counters, or
merge-note checklists. The audience is an agent that must verify and fix bugs.

## Convergence gate — what may be FIXED, not just recorded

Ten overlapping scouts exist so that **convergence filters noise**, not only so
more bugs are found. The suppression asymmetry applies to the FIX phase too: an
applied fix is committed and hard to walk back; a recorded finding can be fixed
any time. So the bias is record, and fixing needs a bar:

- The report artifact has ONE declared grammar, owned by
  `scripts/ultra-review-report.mjs` (`GATE_FIELDS`, `parseGateLine`,
  `parseReport`, `checkReportGate`) — never hand-roll a second parser over the
  same artifact. A report's header carries `Gate: v1`; a report without that
  marker predates the grammar and is declared PRE-GATE (its findings are not
  decision-bearing — one anomaly for the whole file, never inferred
  finding-by-finding from the absence of Action lines).
- Every finding in a gated report carries one exact line: `Convergence:
  <n>/<scouts planned> | Reproduced: yes|no|partial | Contract-breaker: yes|no
  | Action: fix-eligible|record-only`. A field that is missing, TODO, or not
  one of its listed tokens is `unknown` plus an anomaly — ambiguous text is
  never decisive, and an unchosen template placeholder must never parse as a
  chosen value.
- `Action` is RECOMPUTED by `checkReportGate()` (which calls `findingAction()`
  in its own module — the gate's first production consumer), never
  hand-picked: `fix-eligible ⇔ Reproduced=yes AND (Convergence ≥ 3 OR
  Contract-breaker=yes)`. A hand-written Action that disagrees with the
  computed value is itself an anomaly, and the computed value is what
  downstream tooling (`eod-digest.mjs`, and eventually CI) acts on.
- **Reproduction is non-negotiable.** Ten scouts agreeing on a failure nobody
  reproduced is ten shares of one speculation. `partial` is a real token — it
  never satisfies the gate on its own. One scout plus a reproduced
  contract-breaker may fix; ten scouts without a repro may not.
- **Applied is a separate, dedicated line** — `Applied: yes` or `Applied: no`
  inside the finding's own block. It is never inferred from prose ("(not
  applied)" is not "applied") or from a summary table row.
- **Trade-off is the second half of the gate.** A `fix-eligible` finding is
  still not *applied* until its `Trade-off of fixing now` line states what the
  fix costs or risks — "none identified" written out, never implied.
  Convergence answers "is it real"; trade-off answers "is fixing it now a good
  exchange". A fix that is accidentally right is still a wrong decision if
  nobody asked the second question.
- `record-only` is not rejection — it enters the verification queue or round 2.

## Root-cause reopen — the mandatory back-edge

When **two or more findings share one owning mechanism** (one lifecycle, one
ownership boundary, one contract, one foundation function), fixing any of them
individually is symptom-patching. Before ANY of those findings is fixed:

1. The Lead dispatches an **architect-Peer** with an *outcome-level* brief:
   the converged findings, the shared mechanism hypothesis, and the open
   question — "one root or N independent defects? smallest durable design?"
2. The brief must carry `REOPEN_WHEN` and explicit permission to **counter the
   Lead's framing** — the Lead's grouping is provisional, not a conclusion.
   A pre-solved brief ("confirm these share a root") makes the Peer a
   confirmation function and voids the step.
3. Only after the architect's ruling does fixing start — at the root if it
   ruled root, individually if it ruled independent.

**The counter has a bar too.** A Peer counter must carry evidence, impact, and
a premise to reopen; performative contrarianism — disagreement without those
three — is recorded and not rewarded. The invitation to counter the Lead's
framing is not an invitation to perform disagreement. (Source: rooms guide,
Lead profile, via `research/doctrine/03-rooms-setup-guide-check.md`.)

This is the round-1 lesson made rule: seven scouts converged on one path
predicate and the Lead patched it lexically in place — treating the strongest
convergence signal of the round as a list of point fixes instead of as the
question "why do seven traces meet here?"

## Handoff

Findings are candidates. This skill produces no acceptance and no verdict on the
commit. The Lead owns acceptance, a human owns merge and deploy, and corrections
return to the original Engineer, who produces a new commit SHA — never an amend.
