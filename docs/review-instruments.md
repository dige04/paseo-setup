# Review instruments

This pack ships three review skills. They answer different questions and
compose; none substitutes for another. Picking the wrong one is the common
failure — an ultra review that "found nothing" is not an acceptance, and an OCR
`PASS` is not evidence the architecture is right.

| Skill | Question | Bound to | Runs as | Output |
|---|---|---|---|---|
| `paseo-ocr-reviewer` | is this candidate acceptable? | one exact SHA | Reviewer Peer | recommendation + coverage |
| `paseo-ultra-review` | what else might be wrong here? | a scope | Lead + N scout Peers | durable candidate report |
| `paseo-premise-audit` | is this the right kind of system? | whole project | architect Peer (Supervisor commissions) | one verdict + evidence |

## paseo-ocr-reviewer — acceptance

The only one in the acceptance path. Covered in
[`ocr-integration.md`](ocr-integration.md). Deterministic selection through
OpenCodeReview delegation, exact-SHA bound, linked-worktree isolated, fails
closed on a missing CLI rather than degrading to a hand-picked file list.

## paseo-ultra-review — recall

The Lead dispatches N independent read-only scout Peers over a scope with
deliberately overlapping concerns, then consolidates every candidate into one
report under `docs/ultrareview/<date>-<name>-round-<n>.md`.

### Why overlap rather than division of labour

The instinct is to give each scout a distinct specialty — one for performance,
one for security, one for concurrency. That produces N narrow reports and no
cross-validation, and a scout told it owns performance will skip the memory bug
it walked past.

Instead: keep the standing sections of every scout packet identical and vary
only the assigned concern IDs and their angles, and give every scout explicit
permission to report anything else it finds in scope. Two scouts reaching the
same root cause by different traces is signal. One scout reaching it alone is
still a candidate.

### The suppression asymmetry

Recall is the whole point, so the skill forbids filtering at consolidation time.
A candidate dropped during consolidation is gone; a candidate rejected during
verification is recorded and can be revived. That asymmetry is also why a prior
round's rejections are passed to scouts as *warnings*, never as a filter — a
rejection list that prunes the next round turns one reviewer mistake into a
permanent blind spot.

### Cost

Each scout is a real Peer with its own model and daemon session. Ten concurrent
scouts is ten times the tokens and ten sessions of daemon load. Default is 10;
the Lead may scale down to a floor of 4 for a genuinely small scope, and must
record the actual count and the reason in the report. Below 4 the overlap stops
producing cross-validation and the artifact is one opinion with extra steps.

Route scouts `FAST_READ` by default — breadth then careful consolidation beats
ten expensive readers. Escalate individual scouts to `REASONING_HIGH` when their
concern is genuinely deep, and say why in the roster.

### The artifact

`scripts/ultra-review-report.mjs` owns the path, the round number, and the
skeleton, so a Lead cannot improvise a filename or clobber an earlier round:

```bash
node <PASEO_TEAM_SCRIPTS_DIR>/ultra-review-report.mjs \
  --workspace <repo-root> \
  --review-name <slug> \
  --scope "<scope>" \
  --review-brief-sha256 <sha256> \
  --scout-count <n> \
  --directive-count <n>
```

The round number is derived from what is on disk, not from a counter the caller
passes. A Lead that lost context and restarted gets round N+1, never an
overwrite of round 1. `--review-brief-sha256` records which brief the round ran
against, so a later round can prove it is continuing the same review.

### Scope from OCR, not from recollection

`--ocr-manifest` takes a `paseo.ocr-review-manifest/v1` document from
`ocr-review.mjs` and embeds its discovery set, SHA range, and manifest digest.
The two instruments share one selection harness: OCR decides what changed, and
the round becomes reproducible instead of resting on the Lead's description.

The important part is *which* set gets used. OCR's manifest carries both
`reviewable_files` (what it would review) and `excluded_files` (what it dropped,
with reasons). Ultra review takes **both**:

| | OCR review | Ultra review |
|---|---|---|
| `tests/` (`default_path`) | excluded | **in scope** |
| Markdown (`unsupported_ext`) | excluded | **in scope** |
| selected code files | reviewed | in scope |

OCR's exclusions are right for an acceptance decision and wrong for a bug hunt.
A fake-pass test, a fixture that asserts its own output, or a doc contradicting
the code is exactly what `proof-debt-catalog.md` looks for. Measured on a real
agy-acp range: OCR selected 5 of 14 changed files, so taking the selection as
the scout scope would have discarded all five changed test files.

The generated report states that discard count explicitly, lists every
discovered file with its exclusion reason, and adds `DISCOVERED_FILES` /
`FILES_UNREACHED` so a file no scout inspected reads as a limitation.

A manifest that is unreadable, malformed, wrong-schema, missing its SHA range or
digest — or is actually the wrapper's *error envelope*, which is valid JSON —
fails the run. Consuming an error envelope would produce a report that looks
SHA-bound and reports an empty discovery set.

`SCOUTS_PLANNED` / `SCOUTS_SUBMITTED` / `SCOUTS_MISSING` in the report exist so
a scout that never returned reads as a stated limitation rather than as
coverage.

### Write authority, checked before dispatch

The scaffold runs through Bash, which the Lead holds unrestricted — but filling
in the report uses `Write`/`Edit`, which are denied for the Lead unless
`PASEO_TEAM_LEAD_WRITE=1` or the Workspace Protocol grants
`LEAD_WRITE_POLICY: allowed`.

Left unchecked, the failure lands after ten scouts have already been paid for:
the scaffold exists, the candidates are in hand, and the file cannot be
completed. The skill requires confirming write authority *before* dispatching
and reporting `BLOCKED: LEAD_WRITE_UNAVAILABLE` otherwise. Shelling out to write
the file instead is not an option — defeating the gate from Bash would make
every other write restriction in the pack advisory.

### Restart recovery

A restart notice is a recovery trigger, not permission to start over. Freeze the
roster, inventory which logical scouts persisted reports, revive only the
missing ones under their original IDs, and consolidate once. Never create an
extra logical scout to cover a failure — that duplicates completed work and
inflates the apparent independence of the result.

### What it is not

Running ultra review does not satisfy the exact-SHA independent review in
`paseo-team-lead`. It returns candidates, not verdicts, and it is bound to a
scope rather than to a commit. Use it before or alongside the acceptance path,
never instead of it.

## paseo-premise-audit — archetype fit

The only instrument allowed to conclude the code is excellent and still wrong.
It derives the expected capability map from product needs and established domain
mechanisms **before** reading the repository's own decomposition, because
repository vocabulary is a claim rather than evidence. A green suite and a clean
OCR review are inputs here, not the answer.

Verdicts: `KEEP_FOUNDATION`, `REPAIR_FIRST`, `REDIRECT_RECOMMENDED`,
`STOP_AND_REDIRECT`, `INSUFFICIENT_EVIDENCE`.

Domain profiles in `skills/paseo-premise-audit/references/`:

- `realtime-multiplayer-atlas.md` — realtime/MMO/authoritative simulation
- `agent-governance-atlas.md` — multi-agent orchestration, including SLP itself

Plus two lens catalogs shared with ultra review:

- `structural-antipatterns.md` — structural misfit and avoidable-tax lenses
- `proof-debt-catalog.md` — evidence that does not reach the production path

Both catalogs are lenses, not checklists every design must satisfy. Complexity
is a finding only when it lacks a product need, owner, lifecycle, consumer,
scaling contract, or failure contract — visible complexity that the domain
genuinely requires is not overengineering.

It runs as a read-only `solution-architect` Peer. A Supervisor **commissions** it
and reads the verdict but cannot run it: the Claude policy allows the Supervisor
no shell authority beyond the read-only watchdog, and an audit that must trace
production routes would be blocked at its first `Bash` call.

`REDIRECT_RECOMMENDED` and `STOP_AND_REDIRECT` are always
`HUMAN_DECISION_REQUIRED: yes`: changing architectural direction is outside the
Supervisor's delegated decisions, whatever the audit concluded.

## Choosing

- A commit is ready and needs a decision → `paseo-ocr-reviewer`.
- A change is large, the blast radius is unclear, or a previous round missed
  something → `paseo-ultra-review`, then still run OCR review.
- Everything passes and something still feels wrong at the whole-system level →
  `paseo-premise-audit`.
