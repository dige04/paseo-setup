#!/usr/bin/env bash
# onboard.sh — bring one project under SLP, in one command.
#
#   scripts/onboard.sh <project-path>
#
# What it collapses: find the template, copy it, fill in the mechanical fields,
# remember the install flag, remember the verification. Four steps and a doc
# lookup become one command.
#
# What it deliberately does NOT collapse: the decisions. It fills in what it can
# READ (project id, branch, remote, test commands) and leaves every judgment call
# marked `TODO`, then refuses to install the skills while any TODO remains. The
# protocol file is the project's contract; a generated one nobody read is worse
# than none, because it looks like a contract.
#
# Automate the copying, not the thinking.

set -euo pipefail

PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "usage: onboard.sh <project-path>"
  echo
  echo "  Scaffolds <project>/.orchestration/WORKSPACE_PROTOCOL.md from the template,"
  echo "  filling in what can be read from the repo, then installs this pack's skills"
  echo "  into <project>/.claude/skills once no TODO is left in the protocol."
  echo
  echo "  Safe to re-run: an existing protocol is never overwritten."
}

PROJECT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -*) echo "[onboard] unknown argument: $1" >&2; exit 1 ;;
    *)
      [[ -z "$PROJECT" ]] || { echo "[onboard] only one project path is accepted" >&2; exit 1; }
      PROJECT="$1"; shift ;;
  esac
done
[[ -n "$PROJECT" ]] || { usage >&2; exit 1; }
[[ -d "$PROJECT" ]] || { echo "[onboard] not a directory: $PROJECT" >&2; exit 1; }
PROJECT="$(cd "$PROJECT" && pwd)"

# ---------------------------------------------------------------------------
# 0. The runtime is host-wide and must exist first. Onboarding a project onto a
#    runtime that is absent or STALE is how a project silently runs last week's
#    policy — measured on this pack's own host 2026-09-01.
# ---------------------------------------------------------------------------
CLAUDE_TEAM_DIR="${CLAUDE_TEAM_DIR:-$HOME/.claude/paseo-team}"
if [[ ! -f "$CLAUDE_TEAM_DIR/claude-team-hook.mjs" ]]; then
  echo "[onboard] no runtime at $CLAUDE_TEAM_DIR — install it once per host first:" >&2
  echo "            $PACK_ROOT/scripts/install.sh" >&2
  exit 1
fi
DEPLOYED="$(node -p "try{require('$CLAUDE_TEAM_DIR/manifest.json').policyDigest}catch(e){''}" 2>/dev/null || true)"
HERE="$(node -p "require('$PACK_ROOT/manifest.json').policyDigest" 2>/dev/null || true)"
if [[ "$DEPLOYED" != "$HERE" ]]; then
  echo "[onboard] deployed policy differs from this checkout — refresh it first, or the" >&2
  echo "          project inherits a policy nobody here reviewed:" >&2
  echo "            $PACK_ROOT/scripts/install.sh --skip-ocr" >&2
  echo "          deployed: ${DEPLOYED:-<none>}" >&2
  echo "          here:     $HERE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Scaffold the protocol — mechanical fields read, judgment fields marked.
# ---------------------------------------------------------------------------
PROTOCOL_DIR="$PROJECT/.orchestration"
PROTOCOL="$PROTOCOL_DIR/WORKSPACE_PROTOCOL.md"
ROOT_PROTOCOL="$PROJECT/WORKSPACE_PROTOCOL.md"
if [[ -f "$ROOT_PROTOCOL" ]]; then PROTOCOL="$ROOT_PROTOCOL"; fi

if [[ -f "$PROTOCOL" ]]; then
  echo "[onboard] protocol exists: ${PROTOCOL/#$PROJECT/<project>}"
else
  PROJECT_ID="$(basename "$PROJECT")"
  BRANCH="$(git -C "$PROJECT" symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)"
  REMOTE="$(git -C "$PROJECT" remote 2>/dev/null | head -1 || true)"
  # Read the project's own test commands rather than inventing them. A wrong
  # FAST_TEST means every acceptance in the project rests on nothing, so an
  # undetected one stays a TODO instead of being guessed.
  FAST_TEST="TODO — what a Peer runs before reporting"
  FULL_TEST="TODO"
  TYPECHECK=""
  if [[ -f "$PROJECT/package.json" ]]; then
    has() { node -p "!!(require('$PROJECT/package.json').scripts||{})['$1']" 2>/dev/null; }
    [[ "$(has test)" == "true" ]] && FAST_TEST="npm test" && FULL_TEST="npm test"
    [[ "$(has typecheck)" == "true" ]] && TYPECHECK="npm run typecheck"
    [[ -z "$TYPECHECK" && "$(has tsc)" == "true" ]] && TYPECHECK="npm run tsc"
  elif [[ -f "$PROJECT/Makefile" ]] && grep -qE '^test:' "$PROJECT/Makefile"; then
    FAST_TEST="make test"; FULL_TEST="make test"
  elif [[ -f "$PROJECT/pyproject.toml" || -f "$PROJECT/pytest.ini" ]]; then
    FAST_TEST="pytest -q"; FULL_TEST="pytest"
  elif [[ -f "$PROJECT/Cargo.toml" ]]; then
    FAST_TEST="cargo test"; FULL_TEST="cargo test --all"
  fi

  mkdir -p "$(dirname "$PROTOCOL")"
  cat > "$PROTOCOL" <<EOF
# Workspace Protocol — $PROJECT_ID

Scaffolded by \`scripts/onboard.sh\`. Fields it could READ are filled in; every
judgment call is marked TODO. The installer refuses while a TODO remains — this
file is the contract the whole harness is run against, and a generated one
nobody read is worse than none because it looks like a contract.

\`\`\`text
WORKSPACE_PROTOCOL_VERSION: 1

PROJECT_ID: $PROJECT_ID
PROJECT_CRITICALITY: TODO — low | medium | high (how much does a bad merge cost?)
DEFAULT_BRANCH: $BRANCH
REPOSITORY_REMOTE: ${REMOTE:-none}

LEAD_WRITE_POLICY: denied
MERGE_OWNER: human
DEPLOY_OWNER: human

REQUIRED_DOCUMENTS:
- README.md

TEST_COMMANDS:
FAST_TEST: $FAST_TEST
FULL_TEST: $FULL_TEST
TYPECHECK: $TYPECHECK
LINT:
FORMAT_CHECK:
INTEGRATION_TEST:

HUMAN_DECISION_BOUNDARIES:
- TODO — list what is expensive to UNDO in THIS repo, not a generic list.
  Examples to replace: schema migration, public API break, secret or
  infrastructure mutation, anything touching money or user data.
- deployment
- merge

MODEL_POLICY:
MONITOR_ECONOMY: claude-supervisor/claude-haiku-4-5
FAST_READ: claude-peer/claude-haiku-4-5
CODING_MEDIUM: claude-peer/claude-sonnet-5
REASONING_HIGH: claude-peer/claude-opus-5
REVIEW_HIGH: claude-peer/claude-opus-5

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
- FAST_TEST output
- a killing test per fix (mutate the fix, the test must go red)
- independent review when required
- residual risks
- Human decision where required

FAILURE_RECOVERY:
- do not reassign a writer until the old workspace Git state is known
- daemon failure does not imply the agent produced no commit
- restore from the last stable SHA
- never infer a remote endpoint or credential
\`\`\`
EOF
  echo "[onboard] scaffolded ${PROTOCOL/#$PROJECT/<project>}"
fi

# ---------------------------------------------------------------------------
# 2. The TODO gate. This is the step that keeps the contract real.
# ---------------------------------------------------------------------------
# Match only ACTIONABLE lines — a config field or a list item — so the prose in
# the header that explains the TODO convention is not itself counted as one.
TODO_RE='^[A-Z_]+:.*TODO|^- TODO'
TODO_COUNT="$(grep -cE "$TODO_RE" "$PROTOCOL" || true)"
if [[ "$TODO_COUNT" -gt 0 ]]; then
  echo
  echo "[onboard] $TODO_COUNT TODO line(s) left in the protocol. Decide them, then re-run."
  echo "          These are the choices the harness cannot make for you:"
  echo
  grep -nE "$TODO_RE" "$PROTOCOL" | sed 's/^/            /'
  echo
  echo "          Then: $0 $PROJECT"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Skills into this project only — never the global scope.
# ---------------------------------------------------------------------------
"$PACK_ROOT/scripts/install.sh" --skills-only --project "$PROJECT" >/dev/null
echo "[onboard] skills -> <project>/.claude/skills"

IN_WORKTREE_NOTE=""
if git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1; then
  if ! git -C "$PROJECT" check-ignore -q .claude/skills 2>/dev/null; then
    IN_WORKTREE_NOTE="yes"
  fi
fi

echo
echo "[onboard] done. Next:"
echo "  1. Peers run in Paseo worktrees, which are separate checkouts."
if [[ -n "$IN_WORKTREE_NOTE" ]]; then
  echo "     COMMIT .claude/skills/ or the Peer is the one seat that cannot see them:"
  echo "       git -C \"$PROJECT\" add .claude/skills && git -C \"$PROJECT\" commit -m 'add paseo-claude-team skills'"
else
  echo "     .claude/skills is gitignored here — fine only if Peers never run in worktrees."
fi
echo "  2. Start the standing Lead on a HOOKED seat. This is the whole labelling"
echo "     mechanism; skip it and the morning gate is red every day:"
echo "       paseo run --provider claude-lead/claude-opus-5 --cwd \"$PROJECT\" \"<the day's goal>\""
echo "  3. Have that Lead create ONE agent, then confirm the label landed:"
echo "       paseo ls -g --label harness.role=peer --json"
echo "     Do not skip step 3 — until it is observed the automatic path is assumed."
echo "  4. Daily: node $PACK_ROOT/scripts/governance-graph.mjs --assert   (exit 0 = go)"
echo
echo "  Full page: $PACK_ROOT/docs/use.md"
