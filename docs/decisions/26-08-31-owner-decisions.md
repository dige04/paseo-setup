# Owner decisions — 2026-08-31

The three questions in `docs/harness-report.html` §10 were answered by the owner
on 2026-08-31. This file is the record: what was chosen, what was rejected, what
was actually done, and what is still open. It exists so a later reader does not
have to reconstruct the reasoning from a diff.

---

## D1 · The standing Lead moves to a hooked seat — **accepted**

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

**What this does and does not buy.** It disables the **seat**, not a running
agent: the standing Lead started on bare `claude` keeps running unaffected. So D1
is only half a mechanism — it stops the next role-less session from *starting*,
and the standing Lead must still be started on `claude-lead` explicitly. There is
no config that forces that; it is a dispatch discipline the graph can detect
(`enforcementClass` already separates `pack-enforced` from unenforced seats) but
not prevent.

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
