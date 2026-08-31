# Workspace Protocol — paseo-claude-team

This file is the project's opt-in to SLP. `scripts/install.sh --project` refuses
to install the skills without it: a project that has not written its contract has
nothing for the skills to be run against.

The pack governs itself under the same rules it ships. Where a value below is
narrower than the pack default, the narrower one wins — a project may restrict
`config/skill-admission.json`, never widen it.

```text
WORKSPACE_PROTOCOL_VERSION: 1

PROJECT_ID: paseo-claude-team
PROJECT_CRITICALITY: high
DEFAULT_BRANCH: main
REPOSITORY_REMOTE: origin

LEAD_WRITE_POLICY: denied
MERGE_OWNER: human
DEPLOY_OWNER: human

REQUIRED_DOCUMENTS:
- AGENTS.md
- docs/daily-ops.md
- docs/anti-patterns.md
- docs/governance-graph.md
- docs/onboarding.md

TEST_COMMANDS:
FAST_TEST: npm test
FULL_TEST: npm test && node scripts/policy-digest.mjs --check
TYPECHECK: npx tsc -p tsconfig.ci.json --noEmit
LINT:
FORMAT_CHECK:
INTEGRATION_TEST: node scripts/preflight.mjs

HUMAN_DECISION_BOUNDARIES:
- any change under extensions/ that adds, removes or widens a hook gate
- any change to config/skill-admission.json
- any change to the disposition or role vocabulary
- provider config (~/.paseo/config.json) and daemon restarts
- merge and deploy

MODEL_POLICY:
MONITOR_ECONOMY: claude-supervisor/claude-haiku-4-5
FAST_READ: claude-peer/claude-haiku-4-5
CODING_MEDIUM: claude-peer/claude-sonnet-5
REASONING_HIGH: claude-peer/claude-opus-5
REVIEW_HIGH: claude-peer/claude-opus-5

MACHINE_TOPOLOGY:
PRIMARY_HOST: mac-primary
REVIEW_HOST: mac-primary

HOST_CAPABILITY_REQUIREMENTS:
- writers require git-write and focused-test
- reviewers require git-read and independent-review

GIT_POLICY:
ONE_WRITER_PER_MOVING_SCOPE: true
WRITER_WORKTREE_REQUIRED: true
TASK_BRANCH_PATTERN: agent/<task-id>
FORCE_PUSH: denied
PEER_MERGE: denied
PEER_DEPLOY: denied

REVIEW_POLICY:
LOW_RISK: lead acceptance, killing test required
MEDIUM_RISK: one independent reviewer-Peer
HIGH_RISK: one independent reviewer-Peer plus an architect-Peer on the root
EXACT_SHA_REQUIRED: true
FRESH_REVIEW_WORKSPACE: true
REVIEWER_MUST_BE_NEW_SESSION: true

FLEET_POLICY:
NON_CLAUDE_SEATS: read-only scouting only
NON_CLAUDE_WRITE_DISPATCH: denied
MIN_PROVIDERS_PER_REVIEW_SWEEP: 2

ACCEPTANCE_EVIDENCE:
- candidate SHA
- clean worktree
- npm test output
- a killing test per fix (mutate the fix, the test must go red)
- independent review when required
- residual risks
- Human decision where required

FAILURE_RECOVERY:
- do not reassign a writer until the old workspace Git state is known
- daemon failure does not imply the agent produced no commit
- restore from the last stable SHA
- never infer a remote endpoint or credential
```

## Skill admission, narrowed for this project

The pack table in `config/skill-admission.json` applies unchanged. This project
adds no skill and widens nothing. `repo-refresh` stays Human-explicit-only.

## Why the fleet policy line exists

Measured 2026-08-31: an agent on a non-claude provider sees the full Paseo
control plane — 35 orchestration tools reachable under bare names, so a
prefix-based check finds nothing. The pack's hook cannot reach that seat. This
project therefore dispatches non-claude seats to **read-only scouting only**, and
the detection layer (`--assert`, the morning gate) owns the guarantee. See
`docs/decisions/26-08-31-owner-decisions.md` for the trade-off that was accepted
and the two options that were not.
