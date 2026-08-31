# Governance graph

`paseo ls` gives a flat list of agents. It cannot answer the governance
questions: who governs whom, who owns a writable scope right now, and which
bounds apply. This renders that, using [React Flow](https://reactflow.dev/).

```bash
node scripts/governance-graph.mjs                    # current workspace → stdout
node scripts/governance-graph.mjs --out graph.json   # snapshot to a file
node scripts/governance-graph.mjs --serve            # viewer on 127.0.0.1:7788
node scripts/governance-graph.mjs --serve 7788 --all # every workspace
```

Observation-only, exactly like `watchdog.mjs`: it lists and inspects, and never
cancels, archives, spawns or edits.

## What it draws

Both halves of governance are on the canvas, because both are facts:

| Node | Source |
|---|---|
| `CONTROL PLANE` | `paseo status` — daemon state and version |
| `RUN POLICY` | the role pack's declared bounds |
| `SUPERVISOR` / `LEAD` / `PEER` | live agents, by provider |
| `UNKNOWN` | a live agent whose provider declares no role |
| `DURABLE TRUTH` | each distinct workspace the agents touch, keyed by realpath |

| Edge | Meaning |
|---|---|
| `governs` | control plane / supervisor over a seat |
| `bounds` | run policy over every governed agent |
| `delegates` | a real `ParentAgentId`, never inferred |
| `checkpoints` | a seat writing into a workspace |

## Four facts that shape the implementation

**Scoping is client-side.** `paseo ls --json` returns the same global list as
`paseo ls -g --json`; there is no server-side workspace scope. The script
filters on `Cwd` and defaults to the invoking directory, because a global
default is actively misleading — a real machine has agents from many unrelated
projects.

**A directory has one identity: its realpath.** `ls` reports this machine's
workspaces as `~/x` and `inspect` reports the same ones as `/Users/u/x`, so the
graph's own two data sources disagreed about scope on *every* run — one
directory, two keys, and a dual-writer check that could never see a pair.
Every cwd is canonicalized once at ingest (`resolveCanonicalCwds` in
`lib-common.mjs`, shared with the reconciler); raw spellings survive for
display only. A path that will not resolve gets `canonicalCwd: null` plus the
resolve error, and null means *cannot verify* — never "somewhere else", and
never the raw string quietly promoted back into an identity. Agents scoped on
an unresolvable spelling are counted in `meta.scan.cwdUnresolved` rather than
dropped in silence.

**Role comes from the `harness.role` label, with the provider suffix as a
cross-check.** `paseo inspect --json` exposes no `Labels` field, so the label is
read the only way the daemon offers: one `paseo ls --label harness.role=<value>`
per value of a **closed** set, intersected by id — the shape
`reconcile-observer.mjs` already proved on retention, at a fixed cost of three
spawns regardless of fleet size. The set must be closed because the label
channel has exact-match, AND across keys and last-wins, but **no existence
query and no negation**: *"who carries no role?"* is only computable as the
scoped population minus the union of the per-value results.

A **key-only selector fails open** — measured on 0.6.1, `--label harness.role`
returned all 200 agents — so every selector goes through
`validateLabelSelector` and a malformed one **throws instead of querying**. A
sweep that accepted the fail-open answer would conclude that everyone is
labelled, which is the precise inverse of the fail-closed reading.

The two sources are **not interchangeable**:

| Provider | What the suffix is | Label that disagrees with it |
|---|---|---|
| `claude-supervisor` / `claude-lead` / `claude-peer` | a **mechanism** — it selects the provider config that sets `PASEO_CLAUDE_ROLE` and arms the hook | `A7` **violation**: the governance record disagrees with the mechanism |
| anything else | hand-made **text** (`omp-peer` is a name somebody typed) | `A7` `cannotVerify` — two claims disagreeing proves nothing |

A label on an unenforced seat is a **claim**, accepted for *inclusion in the
audited population* and never as authority; a false claim fails safe by adding
scrutiny. A seat with neither source renders as `UNKNOWN`, dashed, with no
`bounds` or `checkpoints` edge. `delegates` edges are still drawn for unknown
agents when Paseo reports a real parent — that is a fact, not an inference.

**`harness.disposition` (Layer 2) is never consulted by an authority gate.** It
records the METHOD — the V3 brief's `DISPOSITION` vocabulary — is
**creation-time only, never authoritative, and never a second source for
`SKILL_ADMISSION`**. Skill admission reads `DISPOSITION` from the *current* V3
brief and from nothing else: a label is written once at create and cannot
follow a seat across tasks, so admitting on it would hand the reviewer skill to
a seat whose current brief is an engineering task. Both vocabularies have one
owner, `extensions/policy-core.mts`; `scripts/lib-common.mjs` holds the single
runtime mirror for `.mjs` consumers and `test/lib-common.test.mjs` fails the
build on drift or on a third literal copy.

**Mode is not authority, and mode ids collide.** What a mode grants depends on
the provider that published it and on whether anything else bounds the seat:

| Provider | Enforcement | Because |
|---|---|---|
| `claude-supervisor` / `claude-lead` / `claude-peer` | `pack-enforced` | the `PreToolUse` hook denies the tool call, and it holds under `bypassPermissions`. It is armed by `PASEO_CLAUDE_ROLE`, which only these three providers set |
| `agy`, `omp`, `codex` | `unenforced` | "nothing in this pack — the hook is passive without `PASEO_CLAUDE_ROLE`". The session mode is the only bound that exists, so posture means something |
| everything else | `unknown` | not enforced, not proven unenforced |

**For a pack-enforced seat, `Mode` is not write authority in either
direction.** `bypassPermissions` on a `claude-peer` is not evidence of a
writer, and `plan` is not evidence of a reader; the hook decides from a V3
brief this graph cannot read. Reading the mode as authority is what made the
one-writer check fire on this repo every morning.

Posture is therefore keyed on `(provider family, mode id)`, from a frozen table
measured against `inspect`'s own `AvailableModes` (2026-08-31):

| Family | write | approval-gated | read-only | measured-but-unclassified |
|---|---|---|---|---|
| `claude` | `acceptEdits`, `bypassPermissions` | `default` | `plan` | `auto` ("Auto mode" — undocumented here) |
| `omp` | `full` | `write` ("Write Approval"), `ask` | — | — |
| `codex` | `full-access` | `auto`, `auto-review` | — | — |
| `agy` | `accept-edits`, `dangerously-skip-permissions` | `default` | `plan` | — (classified from docs; agy publishes no `AvailableModes`) |

omp's `write` is an *ask-first gate*, not a standing grant. The flat token
table this replaces matched it as a confirmed writer while missing codex's
`full-access` entirely — inventing violations at one end and losing real ones
at the other. Lookup is by exact id; `grok` and `cursor` are live on the
measured host and deliberately absent from the table, because nothing
documents what their modes grant.

## Cost

`ParentAgentId` only exists on `inspect`, so edges cost one inspect per agent.
Measured at roughly 30 s for 85 agents, because each inspect is a CLI spawn.
Two bounds keep that from becoming a problem:

- the same bounded concurrency and global deadline the watchdog uses;
- `--serve` caches each snapshot for 5 s and coalesces concurrent requests, so
  a polling viewer pays the fan-out once (measured 14.4 s cold, 8 ms warm).

A snapshot that could not inspect everything is marked `partial` in `meta` and
says so in the status bar, rather than presenting itself as complete.

## Viewer

`web/governance-graph.html` is a single file that loads React and
`@xyflow/react` from `esm.sh`. No build step, no lockfile, no `node_modules`,
and no new CI surface for what is a local dev tool. The tradeoff is that the
first load needs network access; on an air-gapped host, use `--out` and read
the JSON.

`--serve` binds to `127.0.0.1` only — the graph exposes agent ids and workspace
paths.

## Assert mode

`--assert` runs the normal collection, evaluates six topology invariants over
the built graph with the pure `assertTopology(graph)`, and prints
`{ ok, violations, cannotVerify, meta }`. It composes with `--all` / `--cwd`
(and `--out`, which receives the same JSON); it refuses `--serve`.

| Rule | Fires on | Exit 3? |
|---|---|---|
| `A1-one-writer-per-scope` | two **running**, **unenforced**, write-capable peers sharing one **canonical** cwd | yes |
| `A2-writer-is-acceptor` | a lead in a write-capable mode — the lead seat accepts, it does not write | no — advisory |
| `A3-missing-role-record-in-governed-scope` | an agent in a governed scope carrying no `harness.role` record (the **residue clause**) | yes if created after the schema epoch · advisory before it |
| `A4-peer-orchestrates` | a peer that parents any `delegates` edge | yes |
| `A5-supervisor-not-observe-only` | a supervisor that parents `delegates` edges (fact) / holds a write-capable mode (posture) | delegation yes · posture advisory |
| `A6-count-integrity` | `meta` presenting a capped, partial, or **empty** scan as a total | yes |
| `A7-role-record-vs-mechanism` | `harness.role` disagreeing with the provider suffix; also a pack-enforced seat whose record answers to no swept value | yes on a pack-enforced seat with a contradictory swept record · `cannotVerify` for an unconfirmed record and for any non-pack-enforced seat |

Exit codes: `0` — no violations (`cannotVerify` may be non-empty; it is
reported, not a failure), `3` — violations found, `2` — usage or collection
error, as a `{ ok:false, code, message }` envelope on stdout. An unreachable
daemon is a `COLLECTION_FAILED` exit 2, never a green pass over an empty graph.

**Unknown ≠ pass, and a non-signal ≠ a violation.** Those are one rule read in
both directions, and only the first half was implemented. An invariant that
fires every morning on eleven idle agents teaches its operator to stop reading
exit 3, which costs more than the check was ever worth. So the output has three
buckets, not two:

| Bucket | Meaning | Exit |
|---|---|---|
| `violations` | a fact the graph carries breaks an invariant | 3 |
| `cannotVerify` | the graph does not carry the signal — with the concrete reason | 0 |
| `cannotVerify` + `"advisory": true` | the signal exists but is not trustworthy enough to fail a build on, and is named so nobody reads silence as a pass | 0 |

A1 in particular requires three independent signals to line up before it will
call anything a violation:

- **scope** — the canonical directory, so two spellings are one key;
- **liveness** — `status === "running"`. *"May I archive this?"* is a question
  about an idle agent and belongs to `reconcile-observer.mjs`, which has the
  retention evidence for it; *"is something mutating this directory right
  now?"* is this gate's question, and a running process is the only evidence of
  it the graph carries. An idle write-capable population collapses into one
  advisory line per scope naming that owner;
- **authority** — the seat is `unenforced`, so its mode is the whole story.
  Pack-enforced seats produce one `cannotVerify` per scope instead.

A partial snapshot also adds an A4 `cannotVerify` note, because `ParentAgentId`
is only visible via `inspect` and absent edges are not proof.

### The schema epoch, and what this gate still cannot do

`A3` is the **residue clause** and it is where F015's teeth are. Every agent in
a governed canonical scope must carry a `harness.role` record; the ones that do
not are the residue of the set-difference the sweep computes. It is the only
check here that fires on an agent nobody labelled — which is exactly the
population that evaded everything else: all nine offenders measured on
2026-08-31 were children of an **unarmed creator**, so the create-time gate
never saw them, and all nine omitted `harness.owner`, so the reconciler's
cohort never saw them either. The graph scopes by canonical cwd and sees all
nine.

It is a **schema epoch, not a backfill**. `SCHEMA_EPOCH` is the recorded
constant `2026-08-31T12:00:00Z`, compared against `inspect.CreatedAt` — the
only absolute creation time the daemon publishes, since `ls` carries a relative
`"7 hours ago"` string that no epoch can use. It sits after every agent alive
when F015 landed and before any compliant creation:

- **created after it, no record** → violation, exit 3;
- **created before it, no record** → the **DECLARED cohort**: one advisory per
  scope, never a violation. The taxonomy did not exist when those agents were
  created, and relabelling 140 live agents from an unarmed session would
  launder history through the hole being closed. They age out as they are
  archived; there is no backfill;
- **`harness.schema=v2`** ships as a *positive* marker and **must never become
  the epoch test** — an agent created by a non-compliant caller carries no
  marker at all, so absence would read as "pre-epoch" for precisely the
  population the clause exists to catch.

Three fail-closed guards suppress the clause entirely rather than let it
accuse a whole scope: no sweep in the graph, a sweep that did not complete
(`rolesKnown === false` — one failed query makes *everyone* look unlabelled),
and an agent whose `inspect` never answered (one transient `Agent not found`
was observed live).

Still true, and stated because the alternative is a green exit that reads like
assurance:

- **A1's true-positive branch is now reachable and proven.** It needs a seat
  that is both `role=peer` and `unenforced`; before F015 that intersection was
  empty on every fleet the pack could produce, and its only control was a
  hand-built `omp-peer` no shipped config emits. Roles now come from the sweep,
  so a labelled `omp`/`agy`/`codex` seat lands in it. The load-bearing control
  in `test/governance-graph-assert.test.mjs` drives two running labelled peers
  through the **real CLI** to a real exit 3; the suffix-built fixture survives
  only as a secondary control for the fallback path. Quiet is now a finding
  about the fleet, not about the check — but do not "simplify" the three
  suppression clauses on the strength of it.
- **The create-time gate is seat-local forever.** It binds by CREATOR, so it
  covers exactly the children of seats the pack armed. The unarmed-creator set
  (a human window, a bare `claude`, an `omp` seat, the GUI, the CLI) is open
  and always non-empty, so **detection owns the fleet-wide guarantee
  permanently**. Running the standing Lead on `claude-lead` converts that
  coverage from 0% to every child the Lead spawns, which is a configuration
  choice, not a mechanism.
- **A2 and A5-posture stay advisories**, and F015 is no longer the reason.
  They rest on `Mode`, which is not authority on a pack-enforced seat in either
  direction; on an unenforced lead the mode does mean something, but "the lead
  seat accepts, it does not write" is doctrine about how *this pack's* leads
  are run, not a fact about a seat somebody else labelled.
- **The daemon cannot answer "who has no role?" directly.** There is no
  existence selector and no negation, and a key-only selector fails open. The
  set-difference over a closed vocabulary is a workaround; an upstream request
  for existence/negation selectors and for rejecting key-only `--label` is
  recorded.
- **`A7` cannot tell an ABSENT record from an OUT-OF-VOCABULARY one**, and this
  blind spot is occupied, not theoretical. Two `claude-peer` seats on this host
  carry `harness.role=scout` (measured 2026-08-31: `--label harness.role=scout`
  returns 8, two of them pack-enforced). The sweep asks only over the closed set
  `{supervisor, lead, peer}`, so a seat with a *wrong* record answers no query
  and arrives looking exactly like a seat with *no* record.

  What the graph **can** prove is reported: a pack-enforced seat whose record
  answers to no swept value gets an `A7` `cannotVerify` per scope — on those
  providers the suffix *is* the mechanism, so an unconfirmed record is
  paperwork that fails to describe a bound actually in force. What it **cannot**
  do is call that a disagreement, because the population is a mixture: of the 12
  such seats in this repo's scope, 2 carry a wrong value and 10 carry no label
  at all, so a violation would be a false statement about ten of them. The
  missing-record half has an owner with the evidence to judge it — `A3` decides
  it on the schema epoch and exits 3 after it.

  **More queries do not close this.** The out-of-vocabulary set is open, and the
  most principled bounded probe fails on the live data: querying the Layer-2
  disposition vocabulary in the Layer-1 key returns **0** for all five values,
  because the wrong values in the wild are informal short names (`scout`, not
  `repository-scout`). The actual fix is the recorded upstream ask above — an
  existence selector would make "carries this key at all" answerable in one
  query, and the set-difference against the closed set would then be exact.
- **`leadWrite` in the policy node is COLLECTOR-LOCAL.** It reports the
  environment of the process drawing the graph, not of any inspected lead, and
  every line that prints it says so. It is not, and must not become, a
  condition on a verdict about a remote seat. The predicate is shared with the
  hook's own reading and pinned by a parity test in
  `test/lib-common.test.mjs`.

A6 is also why `collectGraph` emits `meta.scan`
(`{ listedTotal, scopedTotal, rendered, truncated, uninspected, cwdUnresolved }`):
previously the `maxAgents` cap (default 100) surfaced only as the lone boolean
`meta.partial` while `meta.counts` silently described the capped list — a
capped scan reading as a total, which is itself the A6 violation. The same
clause now covers the empty scan: `scopedTotal === 0` while the daemon listed
agents is a **violation**, because a mistyped `--cwd` and a clean workspace
used to produce the identical green exit 0.

A6 is also why `collectGraph` now emits `meta.scan`
(`{ listedTotal, scopedTotal, rendered, truncated, uninspected }`): previously
the `maxAgents` cap (default 100) surfaced only as the lone boolean
`meta.partial` while `meta.counts` silently described the capped list — a
capped scan reading as a total, which is itself the A6 violation.
