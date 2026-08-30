# Supervisor Notebook — template

Copy to `docs/supervisor-notebook.md` in the orchestrated repo. Append-only; the Supervisor
writes here freely, no gate. Every failure becomes experience or it is wasted.

**What this is:** durable organizational memory about coordination failures, recurring
anti-patterns, recovery, and protocol experiments — a lab notebook with causal context.
**What this is not:** a transcript dump, a task tracker, a product bug backlog, an authority
source, or a place for secrets.

Three rules that keep it a notebook instead of a log:

1. **`Suspected mechanism` stays separate from `Observation`.** Unproven mechanisms are
   `hypothesis` or `unknown` — never written as fact.
2. **Aggregate repeats into one pattern record.** Not one entry per symptom, not one entry per
   healthy task. Add to an existing record when the episode strengthens a known pattern.
3. **`disproved` records are kept, with the disproof.** Deleting them is how a system relearns
   the same bad change.

Promotion path (see `docs/anti-patterns.md`): entry → `pattern` at ≥2 episodes →
catalog candidate **only if bucket is `role_global`**. `repo_local` lessons go to this repo's
`WORKSPACE_PROTOCOL.md`; `provider_specific` to route notes; `environment_local` expires unless
it recurs. One model's self-report is never sufficient corroboration — require artifacts,
command receipts, timeline state, or a repeated episode.

---

## Record shape

```text
Pattern / episode:   <one line — what happened, e.g. "create_agent failed 4× in a row">
Scope + date:        <project · workspace · 2026-08-30 14:0x>
Observation:         <what was directly observed; no interpretation>
Evidence:            <agent ids, timeline rows, exit codes, file paths — pointers, not dumps>
Suspected mechanism: <hypothesis | unknown>  <e.g. "hypothesis: PASEO_HOST unset on host-4">
Impact/cost:         <momentum | ownership | attention | quality | authority> <minutes lost>
Question for Lead:   <one OPEN question — never "you are wrong, find the bug">
Recovery:            <what happened; who held authority at that moment>
Outcome:             <resolved | worked-around | abandoned | escalated>
Pattern status:      <one-off | repeated | durable | disproved>
Bucket:              <role_global | provider_specific | repo_local | environment_local>
Recommendation:      <smallest correction | none>
Escalation needed:   <no | exact Human/Lead decision required>
Policy digest:       <from `node scripts/preflight.mjs --version` — attributes the episode
                      to the exact governing bytes that were running>
```

---

## Orchestration drift watchlist — imported candidates

Source: W01–W11 from vhlam's supervisor profile, via `research/doctrine/02-vhlam-distill.md` §4
(2026-08-31); W12–W18 from the rooms setup guide, via
`research/doctrine/03-rooms-setup-guide-check.md` §4 (2026-08-31). Same state discipline as the catalog: these stay `candidate` until this
harness observes ≥2 episodes itself — exceptions noted. They are things to *watch for*
while observing; when one fires, open a record above and cite the watchlist ID. Do not
promote from this table directly — promotion goes through the notebook like everything
else.

| # | Drift | State here |
|---|---|---|
| W01 | micro-scoped work orders | candidate (vhlam) |
| W02 | pre-solving implementation — the brief hands the Peer a solution, the Peer becomes a confirmation function | candidate, 1 internal episode (the outcome-brief rule in `paseo-ultra-review` exists because of it) |
| W03 | shadowing an active owner | candidate (vhlam) |
| W04 | staffing roles by template | candidate (vhlam). Guard note: a V3 `DISPOSITION` is an **authority envelope**, not a persona — a disposition changes your **method**, not your scope or authority (rooms guide, Peer profile). Brief the *work*, never the *label*, and return corrections to the seat that already holds the context instead of minting a fresh "fixer" |
| W05 | review without material uncertainty | candidate (vhlam) |
| W06 | duplicate proof — a reviewer reconfirming already-recorded evidence | candidate (vhlam) |
| W07 | passive dispatch | candidate (vhlam) |
| W08 | treating lifecycle status as technical truth | **pattern** — internal evidence: the reconciler exists because "finished" ≠ accepted (unknown → `cannot_verify`) |
| W09 | permission loops — recurring approval ceremony instead of fixing the misconfigured seat | candidate, 1 internal episode (omp `write`-mode storm, dogfood round 1) |
| W10 | context-burning polling — supervisor context grows with no decision produced | candidate (vhlam: a sup grew 40%→80% doing nothing but checking agents). Detector: context growth without a corresponding record or advisory |
| W11 | returning decisions to the Human that the Lead should resolve | candidate (vhlam) |
| W12 | framing capture — one seat's framing quietly becomes the room's conclusion | candidate (rooms guide) |
| W13 | authority-gradient behavior — agreement flows toward perceived rank, not evidence | candidate (rooms guide) |
| W14 | architecture lock-in or fog — structure ossifies (or blurs) without a decision ever being made | candidate (rooms guide) |
| W15 | test-shaped verification — proof that mimics the shape of testing without discriminating power | candidate (rooms guide) |
| W16 | self-acceptance — the writer's own verdict treated as the acceptance | candidate (rooms guide). Cross-note: the mechanism already exists here (writer ≠ acceptor), so an episode of W16 is a mechanism **bypass**, not a missing rule |
| W17 | disproportionate edge-case complexity — rare-path handling dwarfs the main path | candidate (rooms guide) |
| W18 | attention dilution — a seat spread across so many concerns that none gets real attention | candidate (rooms guide) |

Routing note for the fleet stage (recorded, **not yet binding**): when a standing Lead
seat exists, the Human talks to the Supervisor and the Supervisor relays once the
decision is settled — every mid-flight interruption of the Lead spends the attention
that is holding the topology. Today this repo's topology has the Human talking to the
Lead directly; adopt the rule only when the topologies diverge.

---

## Records

### N-001 — <first episode goes here>
```text
Pattern / episode:
Scope + date:
Observation:
Evidence:
Suspected mechanism: unknown
Impact/cost:
Question for Lead:
Recovery:
Outcome:
Pattern status: one-off
Bucket:
Recommendation: none
Escalation needed: no
Policy digest:
```
