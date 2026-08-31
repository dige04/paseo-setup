# Owner decisions — 2026-08-31

The three questions in `docs/harness-report.html` §10 were answered by the owner
on 2026-08-31. This file is the record: what was chosen, what was rejected, what
was actually done, and what is still open. It exists so a later reader does not
have to reconstruct the reasoning from a diff.

---

## D1 · The standing Lead moves to a hooked seat — **accepted, then WITHDRAWN**

> **Status 2026-09-01: the mechanism chosen for D1 was wrong and has been reverted
> on this host and in the shipped example config.** The goal stands; the means was
> a mistake. Read the withdrawal at the end of this section before the history
> above it — the earlier paragraphs are kept because a decision record that quietly
> deletes its wrong turns teaches nothing.

**The problem.** The create-time label gate binds by **creator**: it fires only
when the seat calling `create_agent` is itself armed with `PASEO_CLAUDE_ROLE`.
The standing Lead for this project (agent `34aead2`, measured) was running on the
bare `claude` provider, which sets no role, so the gate never fired and every
child it spawned arrived unlabelled. The morning gate could only report those as
`không xác định` — 9 of them at the time of measurement.

**Done.** Added to `~/.paseo/config.json`:

```json
"agents": { "providers": { "claude": { "enabled": false }, … } }
```

This is install step 1 of `scripts/install.sh`, which had never been merged on
this host. The pack deliberately does not write that file, so this was an
exception made on the owner's instruction; a backup sits at
`~/.paseo/config.json.bak-before-lead-seat-20260831`.

**No backfill.** The F015 ruling put a schema epoch on `inspect.CreatedAt` with no
backfill, and this decision does not reopen it. D1 fixes children created from
here on; the 9 unlabelled agents stay unlabelled and stay visible as such.

### The instruction was wrong, and the restart proved it (2026-09-01)

The owner restarted the daemon as instructed. Afterwards:

```
config agents.providers.claude : {"enabled": true}     ← written back as TRUE
paseo provider ls              : claude  available  Enabled
```

Diffing the pre-edit backup against the post-restart file: **the only change in
the entire config was `claude.enabled: absent → true`.** The edit had not been
reverted by hand or lost to a merge — the daemon wrote it.

**Mechanism.** The daemon holds provider state in memory and persists that state
back to `~/.paseo/config.json`. A file edit the running daemon never loaded is
therefore clobbered by the next `restart`, which then reports success. The
sequence recommended here — *edit now, restart later* — is exactly the sequence
that loses the change. Re-measured immediately after:

| step | `config.claude.enabled` | `paseo provider ls` |
|---|---|---|
| edit the file, daemon running | `false` | `available  Enabled` (not yet applied) |
| `paseo daemon reload` | `false` (kept) | **`unavailable  Disabled`** |

**Corrected instruction, now in `README.md` and `install.sh`:** edit the file and
run **`paseo daemon reload` immediately**. `restart` only after a successful
reload, and only when a full daemon cycle is actually needed.

This also corrects a second claim the pack shipped: "there is no reload; providers
are read only at startup." Reload exists on this build and is the *only* way the
change survives.

### Verified after the reload

`claude` → `unavailable  Disabled`; `claude-supervisor`, `claude-lead`,
`claude-peer` → all `available  Enabled`. The three role providers `extends` the
disabled base and keep working, which the example config and
`test/installer-contract.test.mjs` asserted but nothing had ever run on a host.
Now measured.

### It does not stay disabled — D1 is not a mechanism at all (2026-09-01, 01:37)

Forty minutes after the reload, `agents.providers.claude` was `{"enabled": true}`
again and `paseo provider ls` reported `available  Enabled`.

The daemon had **not** restarted: same pid `71036`, uptime continuous across the
flip. Nor is it a timer — after re-disabling, 90 seconds of continuous
observation held at `false`/`Disabled` with no rewrite, and `provider ls`,
`ls -g` and `daemon status` all left the file's mtime untouched.

The log at the moment of the write:

```
01:34:48  provider-snapshot-manager  Failed to refresh provider snapshot
01:34:50  session  Agent resumed from persistence   origin: "paseo://app"
```

`provider-snapshot-manager` writes the whole provider set back to `config.json`
whenever it refreshes, and built-in providers are materialised as
`enabled: true`. It refreshes on daemon start **and** when the desktop app
reconnects. So the edit survives exactly until the next snapshot refresh, which
is an event nothing in this pack controls or can observe.

**Conclusion, replacing what this file said an hour earlier.**
`"claude": {"enabled": false}` is a **preference, not a mechanism**. It is not
durable, its reversion is silent, and no check here notices. Two corrections
follow:

- The pack must stop presenting it as a guard. `README.md` and `install.sh` now
  say preference, with the measurement.
- **D1 as designed does not achieve its goal.** The goal was that the standing
  Lead sits on a hooked seat so create-time labels fire. No config forces that:
  the disable only stops a *new* role-less session from starting, it never moves a
  running agent, and it reverts on its own. What is left is a dispatch discipline
  — start the standing Lead on `claude-lead` — plus **detection**, which the graph
  already supports (`enforcementClass` separates `pack-enforced` from unenforced
  seats). That is the honest form of D1, and it is detection, like everything else
  in this pack that touches a seat the hook cannot reach.

### WITHDRAWN — it breaks the projects that are supposed to be plain

The owner, on being told `claude` was disabled deliberately:

> *"k được nhé, có những project đơn giản t k cần SLP cơ mà? t dùng thuần thôi"*

That is correct and it should not have taken an owner to catch it. **The same
person had already stated the constraint the day before** — most projects on this
host do not run SLP, which is exactly why the skills were moved out of the global
scope in this very round. I applied a pack default that assumes a
dedicated-to-SLP host to a host that is explicitly mixed, and did it while
implementing the change that says hosts are mixed.

Disabling the base `claude` seat does not merely fail to prevent the thing it
targets. It **breaks every non-SLP project on the host** — the majority — in order
to guard against a mistake in the minority that are governed. Wrong trade, and the
cost lands on the common case.

**Reverted, in three places.**

1. `~/.paseo/config.json` → `claude` back to `enabled: true`, reloaded, verified
   `available  Enabled` alongside all three role providers.
2. `config/paseo.providers.claude.example.json` → ships `"claude": {"enabled": true}`.
3. `test/installer-contract.test.mjs` → now asserts the base provider is **enabled**,
   with the reasoning inline so the next person does not re-derive the old default.

**What survives of D1.** The goal — a Lead on a hooked seat, so create-time labels
fire — is unchanged and still worth having. Its means is now what it should always
have been: start the standing Lead on `claude-lead` (a dispatch discipline), and
**detect** a Lead sitting anywhere else. `governance-graph` already separates
`pack-enforced` from unenforced seats; wiring that into the morning gate is the
open work. Prevention was never available here, and pretending otherwise produced
two wrong instructions in one day.

**The general lesson, for the anti-pattern catalog.** A default that is correct for
a dedicated host becomes a defect on a shared one. This pack ships onto machines
that run governed and ungoverned projects side by side, so every host-wide setting
it recommends must be checked against "what does this do to a project that never
opted in?" The skills-in-global-scope defect and this one are the **same defect**,
found twice in one day, by the owner both times.

**Separate host issue found while measuring, not caused by any of this.** The same
`provider-snapshot-manager` failed 14 times with `Timed out waiting for OMP to
become ready`, alongside 14× `Claude query operation did not settle cleanly
(ProcessTransport is not ready for writing)` and 30× OpenCode `ECONNREFUSED
127.0.0.1:49311`. All 14 OMP timeouts fall in a two-hour window with none in the
preceding eleven hours. A failed refresh flips providers to `unavailable`, which
is what "providers keep turning themselves off" looks like from the app. It is an
OMP readiness problem and it degrades every provider at once, not just `claude`.

**Residual.** ~20 idle agents currently sit on the bare `claude` provider. Whether
they resume after the base is disabled is untested. If resuming one matters, do it
before the restart.

### Blocking D1's stated payoff — a finding, recorded not fixed

D1 was accepted so the morning gate would say something instead of `không xác định`.
Measured today, that gate **cannot go green at all**:

```
node scripts/governance-graph.mjs --assert --all   → exit 3
node scripts/governance-graph.mjs --assert         → exit 3
```

| | |
|---|---|
| Rule | `A5-supervisor-not-observe-only` |
| Agent | `4b28424e` — `claude-supervisor`, **status `closed`**, created 2026-08-22 |
| Evidence | parents 5 delegation edges; the supervisor seat is observe-only and never orchestrates |
| Reproduced | yes, both scopes, exit code observed directly (not through a pipe) |
| Convergence | 2 independent paths (live run + external review) |

The violation is a **historical fact about a finished agent**. No action on today's
topology can clear it, so a gate wired to it is red every morning forever — and a
gate that is always red is a gate that stops being read within a week, which is the
exact failure the digest doctrine in `docs/self-improve.md` warns about.

**Why this looks like a defect in the assert, not in the fleet.** `A1` already
draws the liveness distinction: non-running peers holding a write-capable mode are
reported as `ADVISORY (not a violation)`. `A5` draws no such distinction, so a
closed supervisor and a live one produce the same blocking verdict. The
inconsistency is internal to the assert tier.

**Deliberately not fixed here.** Narrowing `A5` to running seats is a change to a
governance invariant, and the F015 ruling is explicit that these suppression
clauses are not to be "simplified" on the strength of a quiet run. It is also the
kind of one-line change that looks obviously right and is how a real check gets
hollowed out. Options for the owner:

1. **Give `A5` the `A1` liveness clause** — closed seats become advisories, live
   ones stay violations. Consistent with existing precedent; needs a positive
   control proving a *running* supervisor with a delegation edge still reaches
   exit 3, or the fix silently disables the rule.
2. **Archive `4b28424e`** — makes the gate green today, changes nothing about the
   rule, and pushes the same problem to the next closed supervisor.
3. **Accept exit 3 as the standing state** — honest, and useless as a daily gate.

Recommended: 1, with the positive control, run as its own governed change with an
architect-Peer on the root — not folded into this round.

---

## D2 · Wake tier before throughput measurement — **A chosen**

**The choice.** Two open items compete for the same scarce resources (supervision
time, concurrent agent slots): a wake tier for hung agents, and a controlled
measurement of real PR throughput. The owner chose the wake tier first, on the
stated reasoning that a throughput number measured while blind to hung agents is
not a number worth having — you cannot tell how many runs died mid-flight.

**Shipped.** `scripts/wake-tier.mjs` + `test/wake-tier.test.mjs`.

Two properties carry it:

1. **Never single-signal.** A stale `UpdatedAt` is one signal and a long tool call
   looks identical to a hang. A wake also requires the agent's activity tail to be
   byte-identical across two probes separated by `probeGapMs`. Metadata and the
   activity stream come from different paths; agreeing is evidence. Missing the
   second probe yields `cannot-verify` — never a wake.
2. **A permission prompt is not a hang.** `PendingPermissions` is checked *before*
   staleness, because a blocked agent presents exactly like a hung one and waking
   it accomplishes nothing. That branch escalates to a human and never wakes.

The ladder terminates: after `maxAttempts` (2) unanswered wakes an agent becomes
`escalate-to-human` permanently. A watchdog that re-prompts a dead agent every
five minutes is a worse failure than silence.

**Authority.** `watchdog.mjs` stays observation-only — putting an actuator there
would break `mutates:false` and turn `A5` red. The wake-tier **scan** is sanctioned
for Lead and Supervisor; `--wake` is **Lead-only**, because sending a prompt to an
agent is a dispatch and this pack has exactly one dispatcher. Both verdicts ride
the same allowlisted path in `claude-policy.mts`, so the split is the flag and
nothing else.

**Evidence.** `test/wake-tier.test.mjs` includes a positive control that a wake
actually fires through `wakeAgents` with a real `sendPrompt`, not merely that a
disposition equals `"wake-candidate"` — the latter is the AP-02 shape that let
mutation M12 survive a whole review cycle. Six mutations were run against the
module and the hook gate (ladder off-by-one, ignore signal-2 disagreement, blind
scan exits 0, wake any id, ignore the cap, delete the permission check, open the
flag allowlist); all seven were killed.

**Known false positive, stated not hidden.** The two signals come from different
paths but are not independent of the same *cause*: an agent inside one long tool
call — a 20-minute test suite — freezes both. Measured live on 2026-08-31 by
forcing `hungAfterMs` to 1s: two healthy agents classified `wake-candidate`.
Three things bound the cost rather than remove it — the 10-minute default sits
above any sanctioned command, the wake prompt asks for a status line and forbids
new work, and the ladder stops at two. Closing it properly needs a
tool-call-in-flight signal the daemon does not expose; recorded as an upstream ask
rather than guessed at, because a third signal that is really the first one again
would read as more assurance while providing none.

**Operational note.** Set `--hung-after-ms` above the project's own `FULL_TEST`
duration. Lowering it to make the scan livelier is the one wrong move.

**Still open.** Fleet throughput measurement (Q1–Q5), now unblocked and second in
line.

---

## D3 · Non-claude seats stay read-only scouts — **A chosen**

**The problem, measured.** Probe 2026-08-31 (agent `7a2ebbcc`): an `omp` seat sees
**zero** tools named `mcp__paseo__*` but **35 bare-named orchestration tools** —
`create_agent`, `kill_agent`, `archive_workspace`, `respond_to_permission`, … Any
check filtering on the `mcp__paseo__` prefix is blind there. The pack's hook needs
`PASEO_CLAUDE_ROLE`, which only the three claude role providers set, so it cannot
reach that seat at all. Today the only bound is a sentence in the prompt: we detect
a drift afterwards, we do not prevent it.

**Chosen: A — keep them read-only scouts.** Non-claude seats are dispatched
scouting work only; never a write task, never a writer in a fix round. Cost: zero.
The reasoning is a scoping argument, not a capability claim — on a scouting brief
the seat has no reason to touch the control plane, so the gap costs nothing; on a
write brief the same gap is an unbounded seat with an unenforceable contract.

**Rejected, with reasons.**

- **B — adopt a fork with daemon-level binding.** Real prevention, but it replaces
  the official Paseo build with one maintained by an individual. The cost is the
  change to the platform's supply-chain trust, not the installation effort. Revisit
  only if write dispatch to a non-claude seat becomes genuinely necessary.
- **C — request the capability upstream.** Correct, slowest, not certain to land.
  To be sent in parallel; it does not block anything.

**Recorded as doctrine** in `skills/paseo-ultra-review/SKILL.md` (standing rule) and
`.orchestration/WORKSPACE_PROTOCOL.md` (`FLEET_POLICY`). Deliberately **not** a new
hook gate: A was chosen because it costs nothing, and a gate is not nothing.

**What D1 changes here later.** Once the standing Lead sits on `claude-lead`, every
child it spawns — omp seats included — is labelled at creation. That does not
prevent anything, but it makes `--assert` A4 (peer-orchestrates) able to name the
seat instead of reporting an unidentified agent. Detection gets better; prevention
still needs B or C.

---

## Also changed in this round

**Skills moved out of the global scope** (owner: *"không phải dự án nào cũng cần
dùng cơ chế SLP này nên đừng để skill ở cấp global"*). `install.sh` now installs
**no skills by default**; `--project <path>` installs into
`<project>/.claude/skills` and requires that project to have a
`WORKSPACE_PROTOCOL.md` first; `--global-skills` is the explicit opt-out;
`--uninstall-global-skills` reverses a previous global install.

The pack's five skills were removed from `~/.claude/skills` on this host (91 skills
remain, including seven unrelated `paseo-*` skills that are not this pack's and were
not touched). This repo was onboarded to itself via
`.orchestration/WORKSPACE_PROTOCOL.md`. See `docs/onboarding.md`.

No other project on this host had a `WORKSPACE_PROTOCOL.md`, so none was relying on
the global install as a sanctioned SLP project. Any that needs the skills back gets
them with one command.

---

## Closing measurement — why cleaning the three strays does not wrap it up

Asked whether the harness was ready once the three A3 violations were cleared,
the answer measured out as **no**, for a reason worth stating precisely.

**The label mechanism works.** Proven on this host for the first time
2026-09-01: `paseo agent update <id> --label harness.role=lead`, then read back
through the exact selector the sweep uses — `paseo ls -g --label
harness.role=lead` returned it. So A3's post-epoch clause is **satisfiable**. It
is not AP-02; there is a reachable positive path.

**It has never been used.** Of the 56 agents on this host running on
`claude-supervisor` / `claude-lead` / `claude-peer`, **0 carried a
`harness.role` record** before that command. Not a low number — zero, across
every agent the pack has ever produced here.

**So the gate is satisfiable but unsatisfied, and it will be red every day.**
The three current violations are only violations because they happen to be
post-epoch; the other 53 fall in the pre-epoch DECLARED cohort and stay
advisories. Every agent created from now on is post-epoch, so unless something
labels it, each new one is a fresh A3 violation. Clearing the three buys a green
gate until the next agent is created.

**The cause is D1's original goal, arrived at honestly.** The create-time gate
binds by CREATOR. Nothing on this host is an armed creator: the standing Lead
runs on bare `claude`, and an agent a human opens from the app has no creator at
all (`ParentAgentId: null`, checked). So no label is ever written.

**What actually closes it** — and it is not a config setting, which is the whole
lesson of this document:

1. Run the standing Lead on `claude-lead` and dispatch through it, so the
   create-time gate is armed for everything it creates.
2. Verify once, end to end: have that Lead create one agent, then confirm
   `paseo ls -g --label harness.role=peer` returns it. Until that round-trip is
   observed, the automatic path is assumed, not known — the manual path is the
   only one measured so far.
3. Agents a human opens from the app stay outside this permanently. Either label
   them by hand or accept them as advisories; there is no third option at this
   layer (see A8's measured limit).

Only after step 2 is the morning gate something that stays green on ordinary use,
and only then is a throughput measurement worth taking.
