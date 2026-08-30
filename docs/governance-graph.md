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

**Role comes from the provider name, and that is a known gap.**
`paseo inspect --json` exposes no `Labels` field, so the suffix on the provider
name is the only role source the graph has — and only the pack's own `claude-*`
providers carry one. (`paseo ls --label k=v` *is* a working server-side filter,
so a second source exists; which label carries a role is the taxonomy question
F015 owns, and guessing here would make the graph confidently wrong.) An agent
running under plain `claude`, `omp` or `codex` renders as `UNKNOWN`, dashed,
with no `bounds` or `checkpoints` edge. `delegates` edges are still drawn for
unknown agents when Paseo reports a real parent — that is a fact, not an
inference.

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
| `A1-one-writer-per-scope` | two **running**, **unenforced**, write-capable peers sharing one **canonical** cwd | yes (but see the vacuum below) |
| `A2-writer-is-acceptor` | a lead in a write-capable mode — the lead seat accepts, it does not write | no — advisory until F015 |
| `A3-unknown-role-in-governed-scope` | an agent with no role suffix active where role-providers run | no — advisory until F015 |
| `A4-peer-orchestrates` | a peer that parents any `delegates` edge | yes |
| `A5-supervisor-not-observe-only` | a supervisor that parents `delegates` edges (fact) / holds a write-capable mode (posture) | delegation yes · posture advisory |
| `A6-count-integrity` | `meta` presenting a capped, partial, or **empty** scan as a total | yes |

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

### What this gate cannot do yet

Stated here because the alternative is a green exit that reads like assurance:

- **A1's true-positive branch is unreachable on any fleet this pack can
  produce.** It needs a seat that is both `role=peer` and `unenforced` — but
  role is read off the provider suffix that only the pack-enforced `claude-*`
  providers carry. The intersection is empty until **F015** gives roles their
  own source. Its positive control in
  `test/governance-graph-assert.test.mjs` is therefore **synthetic**: a
  hand-built `omp-peer` that no shipped config emits. It is the specification
  A1 will be held to the day F015 lands — do not "simplify" the suppression
  away, and do not read the branch's silence as evidence of a clean fleet.
- **The unenforced fleet is invisible to A1 for the mirror-image reason.**
  `omp`/`agy`/`codex` scouts carry no role suffix at all, so A1 never looks at
  the very seats whose mode *is* authority. Same root, same fix (F015).
- **A2/A3/A5-posture are advisories, not gates.** They rest on the provider
  suffix vocabulary; `harness.role` (the enforced enum) and the provider
  suffix are non-composable today, which is F015's subject.
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
