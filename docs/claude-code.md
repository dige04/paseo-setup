# Claude Code runtime

The role pack was built for Pi. This document covers the second runtime
binding: the same Supervisor / Lead / Peer governance, enforced inside Claude
Code agents launched by Paseo.

Nothing about the Pi runtime changes. The policy itself moved into
`extensions/policy-core.mts`, and each runtime is now a thin binding over it:

```text
extensions/policy-core.mts        pure rules — roles, tool tables, V3 brief
        │                          parser, peer authority, bash guards
        ├── paseo-team-policy.ts   Pi     — setActiveTools + tool_call + mcp proxy guard
        └── claude-policy.mts      Claude — tool names + one PreToolUse decision
                └── claude-team-hook.mjs   hook entry (4 events)
```

One source of truth matters here: `test/policy.test.mts` (1435 lines of
authority regression) exercises the core through the Pi binding, and
`test/claude-hook.test.mjs` asserts the Claude binding reaches the same
verdicts. A rule cannot drift between runtimes without a test failing.

## What is different from Pi

| Concern | Pi | Claude Code |
|---|---|---|
| Role selection | `PASEO_PI_ROLE` | `PASEO_CLAUDE_ROLE` |
| Prompt injection | `before_agent_start` → systemPrompt | `UserPromptSubmit` → `additionalContext` |
| Tool allowlist | `setActiveTools()` | `PreToolUse` deny + provider `disallowedTools` |
| Enforcement | `tool_call` block | `PreToolUse` `permissionDecision: "deny"` |
| Paseo tools | `mcp` proxy, target inside the input | real names: `mcp__paseo__create_agent` |
| `peer_ask_lead` / `team_watchdog` | registered tools | one exact Bash form each |
| Native subagents | none exist | `Agent` / `Task` / `TaskCreate`, **denied for every role** |

Two rules exist only here:

- **`Agent`, `Task` and `TaskCreate` are denied for every role**, Lead included.
  Paseo is the only control plane, and a native subagent is a second one that
  Paseo cannot see, bound, or account for. Pi had no native subagents, so this
  does not fall out of the ported rules — it is enforced explicitly.
- **A Peer may not run `claude` from Bash**, alongside the existing Paseo-CLI
  guard. Spawning a nested session is the same bypass class.

Pi's `mcp` / `mcp_script` proxy guards are deliberately **not** ported. They
exist because Pi hid many Paseo tools behind one tool name; in Claude the
target *is* the tool name, so the check collapses to a prefix match.

## Why hooks rather than permissions

`permissions.deny` in settings is static. Peer authority is not: it is
recomputed from the V3 brief of the **current turn**, so the same tool must be
allowed on one turn and denied on the next. Only a hook can see the prompt and
the tool call.

Verified on Claude Code 2.1.237 (2026-08-20), and the reason this is a real
bound rather than a suggestion:

- Hooks from `--settings` **do** load alongside `--setting-sources=user,project,local`,
  which is what Paseo passes.
- A `PreToolUse` deny is honored **even under `--permission-mode bypassPermissions`
  with `--allow-dangerously-skip-permissions`**. Paseo's Bypass mode does not
  open the gate.
- The payload field carrying the prompt is `prompt` (the published docs say
  `prompt_text`; the hook reads both).

It remains a policy layer, not a sandbox — same caveat as the Pi binding.

## Install

```bash
./scripts/install.sh          # installs both runtimes
```

Claude files land in one flat directory so the hook resolves its policy the
same way in-repo and installed:

```text
~/.claude/paseo-team/
├── claude-team-hook.mjs          hook entry (chmod +x)
├── claude-policy.mts             Claude tool-name binding
├── policy-core.mts               shared rules
├── settings.claude-team.json     generated, absolute hook paths
├── prompts/                      role prompts + claude-runtime-delta.md
├── scripts/                      support scripts (ask-lead, watchdog)
└── state/                        per-session brief state (0600)
```

`~/.claude/settings.json` is **never** modified. The hook wiring lives in its
own settings file that the provider passes with `--settings`, so a plain
`claude` session on the same machine is untouched — and even if the file were
loaded globally, the hook exits 0 immediately when `PASEO_CLAUDE_ROLE` is unset.

Then merge `config/paseo.providers.claude.example.json` into
`~/.paseo/config.json`, replacing `<HOME>` with your home directory, and
restart the daemon when no agent is running.

| Provider | Role | Authority |
|---|---|---|
| `claude-supervisor` | supervisor | observe; monitoring tools; gated lead recovery |
| `claude-lead` | lead | orchestrate, delegate, accept; no product writes by default |
| `claude-peer` | peer | one bounded scope; authority only from the current V3 brief |

## Per-turn authority

Every turn, `UserPromptSubmit` re-parses the V3 brief and injects a short
authority header. The full role prompt goes in once per session; the header
repeats on every turn so a compaction that drops earlier context cannot
quietly widen what the agent believes it may do.

```text
## Paseo Team Role (current turn)

ROLE: peer
MODE: write
TASK_ID: T-42
EDIT: allowed · COMMIT: allowed · PUSH: allowed · FORCE_PUSH/MERGE/DEPLOY: denied
```

A turn with no brief, or a malformed one, resolves to read-only with every
authority denied — and says so in the header.

## Support scripts through Bash

Pi registered `peer_ask_lead` and `team_watchdog` as typed tools. Claude reaches
them through Bash, so each is allowed as exactly **one** command form; anything
chained, redirected or reordered falls through to the ordinary guards:

```bash
node ~/.claude/paseo-team/scripts/team-communication.mjs ask-lead '<json>'   # peer only
node ~/.claude/paseo-team/scripts/watchdog.mjs '<json>'                      # lead/supervisor
```

## Escape hatch

`PASEO_TEAM_EXTRA_TOOLS="mcp__linear__list_issues,..."` allows named tools
per profile — the same env var the Pi binding already uses. Unrelated MCP
servers are otherwise closed for Supervisor and Peer, matching Pi's allowlist.

## Verify

```bash
node scripts/preflight.mjs            # claude-runtime + claude-hooks checks
node test/claude-hook.test.mjs        # the whole authority matrix
```

Live checks worth running once per host, in a scratch repo:

| Ask | Expected |
|---|---|
| Peer, no brief, "write a file" | refused, cites `MODE: read-only` |
| Peer with `MODE: write` + `EDIT_AUTHORITY: allowed` | writes it |
| Peer, "push to main" | refused; only `agent/<TASK_ID>` is pushable |
| Lead, "use the Agent tool" | refused, points at `mcp__paseo__create_agent` |
| Supervisor, "fix this file" | refused, offers an observation instead |
| Plain `claude` in the same repo | unrestricted — proves passivity |
