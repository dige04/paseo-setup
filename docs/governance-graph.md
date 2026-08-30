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
| `DURABLE TRUTH` | each distinct workspace the agents touch |

| Edge | Meaning |
|---|---|
| `governs` | control plane / supervisor over a seat |
| `bounds` | run policy over every governed agent |
| `delegates` | a real `ParentAgentId`, never inferred |
| `checkpoints` | a seat writing into a workspace |

## Two facts that shape the implementation

**Scoping is client-side.** `paseo ls --json` returns the same global list as
`paseo ls -g --json`; there is no server-side workspace scope. The script
filters on `Cwd` and defaults to the invoking directory, because a global
default is actively misleading — a real machine has agents from many unrelated
projects.

**Role comes from the provider name, or not at all.** `paseo inspect --json`
exposes no `Labels` field, so there is no second source. An agent running under
plain `claude` or `codex` renders as `UNKNOWN`, dashed, with no `bounds` or
`checkpoints` edge. In a governance view a confidently wrong edge is worse than
a blank one. `delegates` edges are still drawn for unknown agents when Paseo
reports a real parent — that is a fact, not an inference.

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

| Rule | One line |
|---|---|
| `A1-one-writer-per-scope` | more than one peer in a write-capable mode sharing one cwd |
| `A2-writer-is-acceptor` | a lead in a write-capable mode — the lead seat accepts, it does not write |
| `A3-unknown-role-in-governed-scope` | an agent with no role suffix active in a cwd where role-providers run |
| `A4-peer-orchestrates` | a peer that parents any `delegates` edge |
| `A5-supervisor-not-observe-only` | a supervisor that parents `delegates` edges, or holds a write-capable mode |
| `A6-count-integrity` | `meta` presenting a capped or partial scan as a total |

Exit codes: `0` — no violations (`cannotVerify` may be non-empty; it is
reported, not a failure), `3` — violations found, `2` — usage or collection
error, as a `{ ok:false, code, message }` envelope on stdout. An unreachable
daemon is a `COLLECTION_FAILED` exit 2, never a green pass over an empty graph.

**Unknown ≠ pass.** Every check runs on signals the graph actually carries:
role and cwd from the node data, posture from the `Mode` that `inspect`
reported, parentage from `delegates` edges, totals from `meta.scan`. Only
unambiguous modes classify (`plan`/`readOnly`/`observe` → read-only;
`acceptEdits`/`bypassPermissions`/`yolo`/`write`/`edit` → write); a missing or
approval-gated mode (`default`), a missing cwd, or a missing `meta.scan` lands
the affected check in `cannotVerify` with the concrete reason — never silently
in the pass column, and never guessed into a violation. A partial snapshot also
adds an A4 `cannotVerify` note, because `ParentAgentId` is only visible via
`inspect` and absent edges are not proof.

A6 is also why `collectGraph` now emits `meta.scan`
(`{ listedTotal, scopedTotal, rendered, truncated, uninspected }`): previously
the `maxAgents` cap (default 100) surfaced only as the lone boolean
`meta.partial` while `meta.counts` silently described the capped list — a
capped scan reading as a total, which is itself the A6 violation.
