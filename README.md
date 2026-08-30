# paseo-claude-team

Supervisor / Lead / Peer governance for **Claude Code** agents running under
**Paseo**. Paseo owns lifecycle and control-plane truth; this pack owns role
invariants (prompt + tool policy) and the orchestration procedure.

The rules are enforced by a `PreToolUse` hook, which matters for one measured
reason: **a deny holds even under `--permission-mode bypassPermissions`**, so
the policy is a real bound rather than a suggestion, including in Paseo's
Bypass mode.

```text
extensions/policy-core.mts     runtime-agnostic rules — roles, tool tables,
        │                      the V3 brief parser, peer authority, bash guards
        └── claude-policy.mts   Claude tool names → one allow/deny decision
                └── claude-team-hook.mjs   hook entry (4 events)
```

## Quickstart

```bash
git clone <this repo> && cd paseo-claude-team
./scripts/install.sh                 # add --skip-ocr to skip the global OCR package
```

Then, by hand (the pack never writes your Paseo config):

1. Merge `config/paseo.providers.claude.example.json` into `~/.paseo/config.json`,
   replacing `<HOME>` with your home directory. Keep
   `daemon.mcp.injectIntoAgents: true` — without it agents get no Paseo tools.
   JSON has no comments, so two hardening choices in that file are documented
   here instead:
   - Each role provider pins an owner-approved `models` allowlist
     (`[{"id", "label"}]`, the same shape Paseo custom providers use; ids
     verified live against the running daemon 2026-08-31). The allowlist
     intentionally **replaces** the runtime catalog: after any provider update,
     inspect the runtime catalog (`paseo provider models claude-peer --json`)
     and smoke-test before widening it. Never use `additionalModels` — it
     appends to the catalog instead of replacing it.
   - The built-in `claude` provider is disabled (`"claude": {"enabled": false}`)
     so a role-less session cannot be started by accident. The three role
     providers extend `claude` and keep working — this mirrors a verified
     upstream pattern.
2. `paseo daemon restart` **when no agent is running**. There is no reload;
   providers are read only at startup, and a restart kills running agents.
3. `paseo provider ls` → `claude-supervisor`, `claude-lead`, `claude-peer`.
4. `node scripts/preflight.mjs`

`~/.claude/settings.json` is never modified. The hook wiring lives in its own
settings file that the provider passes with `--settings`, so a plain `claude`
session is untouched — and even if it were loaded globally, the hook exits 0
immediately when `PASEO_CLAUDE_ROLE` is unset.

## Roles

| Provider | Role | Authority |
|---|---|---|
| `claude-supervisor` | supervisor | observe; monitoring tools; one gated lead-recovery `create_agent` |
| `claude-lead` | lead | orchestrate, delegate, accept; no product writes unless `PASEO_TEAM_LEAD_WRITE=1` |
| `claude-peer` | peer | one bounded scope; authority **only** from the current V3 brief |

`Agent`, `Task` and `TaskCreate` are denied for **every** role. Paseo is the
only control plane; a Claude-native subagent is a second one Paseo cannot see,
bound, or account for. The Lead delegates through `mcp__paseo__create_agent`.

## How authority works

Every authority is recomputed from the brief of the **current turn**. A turn
with no valid V3 marker block is read-only.

This has a consequence worth knowing before you use it: **sending a working
Peer a plain chat message strips its write authority for that turn**, because
your message carries no brief. Talk to the Lead, which re-issues a proper
brief; don't message Peers directly.

- Only a `PASEO_TEAM_TASK_V3_BEGIN … END` block can grant write or git authority.
- Push is branch-scoped to exactly `git push -u origin HEAD:refs/heads/agent/<TASK_ID>`.
- Force-push is blocked in every spelling (`-f`, `-uf`, `--force*`, `+refspec`);
  so are peer merges and `--amend`.
- Anything unparseable resolves to read-only with all authority denied.

See [`docs/claude-code.md`](docs/claude-code.md).

## Review instruments

Three skills, three different questions. They compose; none replaces another.

| Skill | Answers | Bound to | Runs as |
|---|---|---|---|
| `paseo-ocr-reviewer` | is this candidate acceptable? | one exact SHA | Reviewer Peer |
| `paseo-ultra-review` | what else might be wrong here? | a scope | Lead + N scout Peers |
| `paseo-premise-audit` | is this the right kind of system? | whole project | architect Peer (Supervisor commissions) |

**OCR review** is the acceptance path: deterministic file selection through
OpenCodeReview delegation, exact-SHA bound, linked-worktree isolated, fails
closed. See [`docs/ocr-integration.md`](docs/ocr-integration.md).

**Ultra review** is maximum recall: the Lead dispatches independent read-only
scouts with deliberately overlapping concerns and consolidates every candidate —
including speculative ones — into one durable report under `docs/ultrareview/`.
It over-reports on purpose. It is *not* an acceptance instrument: running it
does not satisfy the independent review step, and a quiet ultra review does not
imply `PASS`. Cost is real — each scout is a Peer with its own model session, so
the default of 10 is scalable down to 4 with the count and reason recorded.

It shares OCR's selection harness: pass an `ocr-review.mjs` manifest with
`--ocr-manifest` and the scope becomes SHA-bound and reproducible instead of
hand-described. Scouts get OCR's **discovery** set, not its selection — OCR
drops `tests/` and Markdown because they are out of scope for *acceptance*, and
a fake-pass test is exactly what a bug hunt should find.

**Premise audit** is the only one allowed to conclude the code is excellent and
still wrong. It derives the expected capability map before trusting repository
vocabulary, and returns one verdict from `KEEP_FOUNDATION` to
`STOP_AND_REDIRECT`. Domain profiles ship for realtime-multiplayer and
agent-governance systems.

[`docs/review-instruments.md`](docs/review-instruments.md) covers when to reach
for which, and the authority each one needs before it starts.

## Governance graph

Who governs whom, who owns a writable scope, and which bounds apply — as a
[React Flow](https://reactflow.dev/) view of live Paseo state:

```bash
node scripts/governance-graph.mjs --serve     # http://127.0.0.1:7788
```

Clicking an agent node opens that session in Paseo Desktop. Declare it in a
project's `paseo.json` as a `"type": "service"` script and Paseo supervises it
and gives it a proxy hostname its built-in browser can open. See
[`docs/governance-graph.md`](docs/governance-graph.md).

## Labels and daily cleanup queue

Paseo 0.6.1 has two distinct label surfaces. The colored labels in the
workspace menu are workspace labels; its supported CLI/MCP currently cannot
assign them, so use the UI for the small visual vocabulary `active`, `review`,
`observe`, `blocked`, `keep`, and `cleanup`. Use at most one phase plus optional
`keep`. There is deliberately no `done`: a completed workspace should leave the
active surface, not become a permanent completion artifact.

The Lead adds supported machine-readable agent labels to every new team
session: `harness.owner`, `harness.run`, `harness.project`, `harness.role`,
`harness.task`, and `harness.retention`. Remote creation has parity through
`remote-paseo.mjs --labels key=value,...`. These labels make the daily observer
ownership-scoped; it never guesses from a provider, title, branch, or age.

**`harness.project` must equal the Paseo workspace `project` field** (the name
shown by `paseo workspace ls`), because a project-scoped reconcile filters
workspaces by that field AND appends `harness.project=<project>` to the managed
label selectors — a mismatched value makes every owned agent read as *foreign*
and the workspace refuse with `no_managed_agent_history`. Found live in E2E:
that failure direction is safe (fail-closed) but silently makes the observer
inert for the whole project.

```bash
node ~/.claude/paseo-team/scripts/watchdog.mjs \
  '{"mode":"daily-reconcile","project":"paseo-harness","includeOrphans":true}'
```

That is the default installed path accepted by the Supervisor's exact-command
allowlist. If `PASEO_TEAM_SCRIPTS_DIR` is customized, substitute its resolved
absolute value; do not pass the literal variable name. A human working in this
source checkout may use `node scripts/watchdog.mjs ...` instead.

The report is deterministic JSON with schema `paseo.team-reconcile/v1` and
always says `mutates: false`. A workspace enters its cleanup queue only when
all managed agents are archived, no foreign agent/terminal/process is using
the tree, Git has no tracked, untracked, or ignored local files, HEAD is
remote-reachable and merged into the observed base, the path is Paseo-owned,
and the grace period has elapsed. Any failed or
unknown check means KEEP / `cannot_verify`; `idle` is never completion proof.
For each accepted worktree candidate the report emits a separate local-branch
review item bound to the same expected HEAD; it never proposes remote deletion.

Run that exact command daily from the scheduler you already operate (or from a
Paseo scheduled Supervisor). The pack does not create a schedule because time,
timezone, project, and provider are host-local choices. It also does not invoke
`workspace archive` unattended: Paseo 0.6.1 force-removes a managed worktree in
that path, so the queue remains human-reviewed until Paseo exposes a no-force,
expected-HEAD cleanup primitive. The report also surfaces
`daemon.autoArchiveAfterMerge`; it does not treat that setting as closure proof
because 0.6.1 permits unknown Git evidence and does not check an expected HEAD.
Cleanup classification is version-pinned to 0.6.1; another or unreadable daemon
version yields `cannot_verify` until its semantics are reviewed.
On Windows the process/open-file probe is unavailable, so retirement remains
`cannot_verify`; this is an intentional fail-closed limitation, not clearance.

## Model routing

Five classes so the Lead routes by **task risk**, not by habit — a monitoring
sweep should not cost what a review costs. Copy
`config/model-routing.example.json` → `~/.paseo-claude-team/model-routing.local.json`
and confirm ids with `paseo provider models claude-peer --json`.

| Class | Example |
|---|---|
| `MONITOR_ECONOMY` / `FAST_READ` | cheap, low thinking |
| `CODING_MEDIUM` | `claude-peer/claude-sonnet-5`, medium |
| `REASONING_HIGH` / `REVIEW_HIGH` | `claude-*/claude-opus-5`, high |

`preflight.mjs` checks every route against the live provider inventory, so a
model that does not exist fails before an agent is ever created.
[`docs/model-routing.md`](docs/model-routing.md) ·
[`docs/multi-host.md`](docs/multi-host.md)

## What this pack does NOT do

Stated plainly, because each has bitten during testing:

- **`OWNED_SCOPE` / `EXCLUDED_SCOPE` are not enforced.** The brief declares
  scope; the hook gates *whether* you may write, not *where*. Agents have
  honoured it, but it is convention backed by the reviewer reading the diff —
  not a wall. Write-mode Peers also hold `Bash`, so a real bound would have to
  constrain shell writes too.
- **No product layer.** There is no PRD, story, or acceptance-criteria
  vocabulary. Every objective comes from a human.
- **Parallel writers are unmodelled.** Read-only peers parallelise; concurrent
  writers would need worktree isolation per writer.
- It is a policy layer, **not a sandbox**.

## Development

```bash
npm ci && npm run check      # 16 suites + tsc
```

Node **22.18+** runs `.ts`/`.mts` directly via type stripping — required, since
the hook imports its policy as `./claude-policy.mts`.

## Compatibility

| Component | Version | Verified |
|---|---|---|
| Paseo CLI/daemon | 0.6.1 | 2026-08-30 |
| Claude Code | 2.1.237 | 2026-08-21 |
| Node | ≥ 22.18 | 2026-08-21 |
| OpenCodeReview | ≥ 1.8.10 (pins 1.9.2) | optional, reviewer flow only |

Derived from the Pi role pack `paseo-pi-team`; the Pi runtime binding,
`pi-mcp-adapter` and `agent-browser` MCP setup are not carried here.

## License

[MIT](LICENSE).
