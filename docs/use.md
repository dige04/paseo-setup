# Using it — one page

`docs/daily-ops.md` is the full runbook. This is the short version: the setup step
that is easy to skip, the three commands you actually run, and what to do when the
gate is red.

---

## Once per host — the step that is usually missed

The pack labels every agent with who it is (`harness.role`). Those labels are what
the morning gate reads. They are written by a **create-time gate that binds by
CREATOR**: it fires only when the seat calling `create_agent` is itself a
`claude-supervisor` / `claude-lead` / `claude-peer` seat.

Measured on this host 2026-09-01: **0 of 56** agents on role providers carried a
label. Nothing was ever an armed creator, so no label was ever written. Skip this
step and the gate is red every day for a reason that has nothing to do with your
code.

```bash
# 1. Start the standing Lead on a hooked seat — this is the whole fix.
#    Not a config setting. Where you start the Lead IS the mechanism.
paseo run --provider claude-lead/claude-opus-5 --cwd <project> "<the day's goal>"

# 2. Have that Lead create ONE agent, then confirm the label appeared:
paseo ls -g --label harness.role=peer --json
```

If step 2 returns the new agent, the automatic path works and you are done — every
agent that Lead creates from now on is accounted for. **Do not skip the
confirmation.** Until it is observed, the automatic path is assumed, not known;
only the manual path (below) has been measured.

**Agents you open yourself from the Paseo app stay outside this, permanently.**
They have no creator (`ParentAgentId: null`), so nothing can label them and nothing
can attribute them. Label them by hand, or accept them as advisories:

```bash
paseo agent update <id> --label harness.role=peer     # verified working
```

---

## After every `git pull` on this pack

The runtime is deployed to `~/.claude/paseo-team/`, and a pull does **not** update
it. Agents keep enforcing whatever was deployed last.

```bash
./scripts/install.sh --skip-ocr    # redeploy the runtime
node scripts/preflight.mjs         # exit 0 = deployed policy == this checkout
```

Measured 2026-09-01 on this pack's own host: the deploy was missing seven support
scripts and its hook carried none of that day's gates, while every existing-file
check passed clean. `preflight` now compares the deployed `policyDigest` against
this checkout and **fails** on a mismatch, so the drift is loud instead of silent.

## Every day

```bash
node scripts/governance-graph.mjs --assert     # topology. exit 0 = go.
node scripts/wake-tier.mjs                     # hung agents. exit 0 = nothing stuck.
node scripts/eod-digest.mjs --workspace .      # end of day, decisions only
```

Run the first two from the project directory, not the pack. `--assert` with no
`--cwd` scans the current directory: a scope that matches nothing exits 3 on
purpose (an empty scan is not a clean one).

---

## What the colours mean

| Exit | Means | Do |
|---|---|---|
| **0** | nothing needs you | dispatch |
| **3** | something needs a person | read the `violations` array — it names the agents |
| **2** | the tool failed | environment problem; the envelope says which |

**`cannotVerify` is not failure.** It is the check saying *"I cannot answer this
from the evidence I have"*, with the reason. Entries marked `advisory: true` are
deliberately not violations — they never block. Fifteen on this host today is
normal, not a backlog.

### The red you will actually hit

| Rule | Meaning | Fix |
|---|---|---|
| `A3-missing-role-record` | an agent created after the schema epoch carries no `harness.role`, in a scope where you are running the pack | label it, or archive it if it is finished |
| `A1-one-writer-per-scope` | two running write-capable peers on one directory | stop one — this one really does invalidate the day's evidence |
| `A6-count-integrity` | the scan matched nothing while the daemon listed agents | wrong `--cwd`, or use `--all` |

A3 is the common one, and it is the pack working as intended: you ran a governed
seat and it has no record. The permanent fix is the setup step above.

---

## What it does not do

Stated because a gate you trust for the wrong thing is worse than no gate.

- **It does not prevent anything on a non-claude seat.** An `omp`/`agy` agent sees
  the full Paseo control plane; the hook cannot reach it. Give those seats
  read-only scouting work only — that is a scoping decision, not a bound
  (`docs/decisions/26-08-31-owner-decisions.md`, D3).
- **It cannot say who opened an agent from the app.** Paseo records no creator for
  it, so an unlabelled stray can be reported but never attributed.
- **A wake can be wrong.** One long tool call freezes both signals the wake tier
  reads. Keep `--hung-after-ms` above your longest sanctioned command.
- **Nothing here merges or deploys.** By construction.
