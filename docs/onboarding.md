# Onboarding a project

Most projects should **not** run SLP. Two agents on a small feature is overhead,
not governance, and the ceremony costs more than the coordination it buys. This
page is as much about deciding not to onboard as about onboarding.

## What is host-wide and what is per project

This split is the thing to get right first; everything else follows from it.

| | Where | Why it cannot be otherwise |
|---|---|---|
| Runtime — hook, policy, support scripts, state | `~/.claude/paseo-team/` — **one per host** | The Paseo provider passes `--settings <abs path>`, `PASEO_TEAM_SCRIPTS_DIR` and `PASEO_TEAM_STATE_DIR` are absolute, and the bash allowlist compares **full** paths. A per-project runtime would fail every sanctioned command. |
| Provider config | `~/.paseo/config.json` — **one per host** | Providers are read at daemon startup. |
| Skills — the workflows | `<project>/.claude/skills/` — **per project** | A skill in `~/.claude/skills` is offered to every session on the host, including the ones that should be plain Claude Code. |
| `WORKSPACE_PROTOCOL.md` | `<project>/.orchestration/` (or the repo root) | It is the project's contract: scopes, test commands, who merges. |

Installing the skills globally puts an orchestration workflow in front of every
session on the machine. That is why `install.sh` installs **no skills by
default** and `--global-skills` is an explicit opt-out.

## Should this project use SLP at all?

Onboard when **two or more** of these hold:

- More than one agent will write to the repo in the same day.
- Work runs unattended long enough that a hung agent would go unnoticed.
- A defect reaching `main` costs more than the review round costs.
- You want the convergence gate — several independent reads before any fix.

Do **not** onboard for: a solo session, a spike, a repo you are reading rather
than changing, or a project where you will merge whatever the agent writes. In
those, plain Claude Code is better and the pack adds nothing but friction.

There is no penalty for deciding later. Onboarding is two commands and reverses
with `rm -rf <project>/.claude/skills`.

## The one-command path

```bash
./scripts/onboard.sh <project-path>
```

Reads what it can (project id, branch, remote, test commands), scaffolds
`<project>/.orchestration/WORKSPACE_PROTOCOL.md`, installs the skills into that
project only, prints the verification steps. Refuses if the host runtime is
missing **or drifted**, and refuses while any `TODO` remains in the protocol.

It automates the copying, not the thinking. Expect to decide two things:
`PROJECT_CRITICALITY`, and what is expensive to *undo* in this specific repo.
Safe to re-run; an existing protocol is never overwritten.

The manual path below is the same steps, spelled out — useful when you want to
know what the command did, or when scaffolding is not wanted.

## Onboarding, step by step

**Once per host.** Skip if `~/.claude/paseo-team/` already exists.

```bash
scripts/install.sh                       # runtime + hook + OCR, no skills
# then follow its steps 1-4: merge the provider example into ~/.paseo/config.json,
# restart the daemon, confirm `paseo provider ls | grep claude-`, run preflight.
```

**Once per project.**

```bash
# 1. Write the contract. This is the real work; the rest is copying files.
mkdir -p <project>/.orchestration
cp templates/WORKSPACE_PROTOCOL.example.md <project>/.orchestration/WORKSPACE_PROTOCOL.md
$EDITOR <project>/.orchestration/WORKSPACE_PROTOCOL.md

# 2. Install the skills into that project only.
scripts/install.sh --skills-only --project <project>

# 3. Decide whether to commit .claude/skills/ — see below.
```

Step 2 refuses to run without step 1, and that refusal is the point: skills
without a protocol give an agent a workflow and no contract to run it against.

### Filling in the protocol

Four fields decide most of the behaviour. The rest can stay at the template's
defaults on the first pass.

- `TEST_COMMANDS.FAST_TEST` — what a Peer runs before reporting. If this is
  wrong, every acceptance in the project is built on nothing.
- `HUMAN_DECISION_BOUNDARIES` — what an agent must stop and ask about. Add the
  things that are expensive to undo in *this* repo, not a generic list.
- `GIT_POLICY.ONE_WRITER_PER_MOVING_SCOPE` — leave `true`. Two writers in one
  scope is the failure the pack exists to prevent.
- `MERGE_OWNER: human` — leave it. Nothing in the pack merges.

`.orchestration/WORKSPACE_PROTOCOL.md` in this repo is a filled-in example.

### Commit `.claude/skills/`, or not

Peers run in **Paseo worktrees** — `~/.paseo/worktrees/<project>/<branch>` —
which are separate checkouts. An uncommitted `.claude/skills/` exists in the
project root and nowhere else, so the Peer that needs the workflow is the one
seat that cannot see it.

- **Peers will run in worktrees** (the normal mode): commit `.claude/skills/`.
- **Only the root checkout is used**: add it to `.gitignore` and regenerate with
  the install command after a pack update.

This repo gitignores it, because `skills/` here is the source of those files —
committing the copy would double the governed bytes and invite drift.

## Verify before the first dispatch

```bash
node ~/.claude/paseo-team/scripts/preflight.mjs        # host readiness
node ~/.claude/paseo-team/scripts/governance-graph.mjs --assert   # exit 0 = topology clean
cd <project> && ls .claude/skills                      # the project sees them
```

Then dispatch one throwaway Peer on a read-only brief and confirm the hook is
armed: ask it to write a file. It must be **denied**. A Peer that writes is a
Peer on an unhooked seat, and everything downstream of that is unenforced.

## Keeping projects in sync after a pack update

The runtime and the skills update separately — that is the cost of the split.

```bash
scripts/install.sh                                   # runtime, once
for p in <project-a> <project-b>; do
  scripts/install.sh --skills-only --project "$p"
done
```

`node scripts/policy-digest.mjs --check` tells you whether the governed bytes
moved; if they did, the projects need step two.

## Removing SLP from a project

```bash
rm -rf <project>/.claude/skills
```

Leave `WORKSPACE_PROTOCOL.md`: it is a useful record of the project's contract
even when no agent is reading it, and it is what makes re-onboarding one command.

To pull the pack's skills out of `~/.claude/skills` on a host that installed them
globally before this split:

```bash
scripts/install.sh --uninstall-global-skills
```

It removes exactly the five directories this pack owns and never touches a
neighbouring skill.
