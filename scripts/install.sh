#!/usr/bin/env bash
# install.sh — install the paseo-claude-team role pack for Claude Code.
#
# Everything lands in one flat directory so the hook resolves its policy the
# same way in-repo and installed:
#
#   ~/.claude/paseo-team/
#     claude-team-hook.mjs        hook entry (4 events)
#     claude-policy.mts           Claude tool-name binding
#     policy-core.mts             shared rules
#     settings.claude-team.json   generated, absolute hook paths
#     prompts/  scripts/  state/
#
# Skills are NOT installed here by default: they are per project
# (<project>/.claude/skills), because ~/.claude/skills is offered to every
# session on the host. See --project / --global-skills below, and docs/onboarding.md.
#
# It does NOT touch ~/.claude/settings.json: the hook wiring lives in its own
# settings file that the Paseo provider passes with --settings, so a plain
# `claude` session is unaffected. It also does NOT write ~/.paseo/config.json —
# merge config/paseo.providers.claude.example.json by hand, so the change stays
# under your control.

set -euo pipefail

SKIP_OCR=0
SKILLS_ONLY=0
GLOBAL_SKILLS=0
UNINSTALL_GLOBAL_SKILLS=0
PROJECT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-ocr) SKIP_OCR=1; shift ;;
    --project)
      [[ $# -ge 2 ]] || { echo "[paseo-claude-team] --project requires a path" >&2; exit 1; }
      PROJECT_DIR="$2"; shift 2 ;;
    --global-skills) GLOBAL_SKILLS=1; shift ;;
    --uninstall-global-skills) UNINSTALL_GLOBAL_SKILLS=1; shift ;;
    --skills-only) SKILLS_ONLY=1; shift ;;
    -h|--help)
      echo "usage: install.sh [--project <path>] [--skills-only] [--global-skills]"
      echo "                  [--uninstall-global-skills] [--skip-ocr]"
      echo "  --project <path>            install the skills into <path>/.claude/skills."
      echo "                              Requires <path>/WORKSPACE_PROTOCOL.md: that file is"
      echo "                              the project's opt-in to SLP. No protocol, no skills."
      echo "  --skills-only               skip the runtime/hook/OCR install. Use this to onboard"
      echo "                              the 2nd..Nth project once the runtime is already there."
      echo "  --global-skills             install the skills into ~/.claude/skills for EVERY"
      echo "                              session, SLP or not. Opt-in, and rarely what you want."
      echo "  --uninstall-global-skills   remove the pack's skills from ~/.claude/skills, then exit."
      echo "  --skip-ocr                  do not install the OpenCodeReview CLI (a global npm package)"
      exit 0 ;;
    *) echo "[paseo-claude-team] unknown argument: $1" >&2; exit 1 ;;
  esac
done

ROLE_PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_TEAM_DIR="${CLAUDE_TEAM_DIR:-$HOME/.claude/paseo-team}"
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

# The skills the pack owns. Named once: the install loop, the global uninstall
# and the summary all read this list, so a skill can never be installed by one
# and missed by the other.
PACK_SKILLS=(paseo-team-lead paseo-ocr-reviewer paseo-ultra-review paseo-premise-audit repo-refresh)

# --uninstall-global-skills is a standalone action. It removes only the five
# directories this pack owns and never touches a neighbouring skill.
if [[ "$UNINSTALL_GLOBAL_SKILLS" -eq 1 ]]; then
  removed=0
  for skill in "${PACK_SKILLS[@]}"; do
    if [[ -d "$CLAUDE_SKILLS_DIR/$skill" ]]; then
      rm -rf "$CLAUDE_SKILLS_DIR/$skill"
      echo "[paseo-claude-team] removed $CLAUDE_SKILLS_DIR/$skill"
      removed=$((removed + 1))
    fi
  done
  echo "[paseo-claude-team] removed $removed global skill(s); the runtime at $CLAUDE_TEAM_DIR is untouched"
  exit 0
fi

# Where the skills land. Default is NOWHERE: most projects do not run SLP, and
# a skill in ~/.claude/skills is offered to every session on the host — including
# the ones that should just be plain Claude Code. Scope is opt-in per project.
SKILLS_TARGET=""
if [[ -n "$PROJECT_DIR" ]]; then
  [[ -d "$PROJECT_DIR" ]] || { echo "[paseo-claude-team] --project path does not exist: $PROJECT_DIR" >&2; exit 1; }
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
  # WORKSPACE_PROTOCOL.md is the opt-in marker, not a formality: it is the file
  # that says which scopes exist and how this project restricts skill admission.
  # Installing the skills without it would hand an agent a workflow with no
  # project contract to run it against.
  #
  # Both locations count. The template documents .orchestration/, repos that
  # keep no such directory put it at the root, and refusing one of the two on a
  # technicality would only teach people to bypass the check.
  if [[ ! -f "$PROJECT_DIR/WORKSPACE_PROTOCOL.md" && ! -f "$PROJECT_DIR/.orchestration/WORKSPACE_PROTOCOL.md" ]]; then
    echo "[paseo-claude-team] $PROJECT_DIR has no WORKSPACE_PROTOCOL.md — that file is the project's opt-in to SLP." >&2
    echo "[paseo-claude-team] Put it at .orchestration/WORKSPACE_PROTOCOL.md (or the repo root)," >&2
    echo "[paseo-claude-team] starting from templates/WORKSPACE_PROTOCOL.example.md, then re-run." >&2
    exit 1
  fi
  SKILLS_TARGET="$PROJECT_DIR/.claude/skills"
elif [[ "$GLOBAL_SKILLS" -eq 1 ]]; then
  SKILLS_TARGET="$CLAUDE_SKILLS_DIR"
fi

if [[ "$SKILLS_ONLY" -eq 1 && -z "$SKILLS_TARGET" ]]; then
  echo "[paseo-claude-team] --skills-only needs --project <path> (or --global-skills); there is nothing else to do" >&2
  exit 1
fi

TEAM_SUPPORT_FILES=(
  # lib-common.mjs must ship: every other support script imports it as
  # "./lib-common.mjs" and would fail at import time without it.
  lib-common.mjs
  reliability.mjs
  reconcile-core.mjs
  reconcile-observer.mjs
  policy-digest.mjs
  watchdog.mjs
  wake-tier.mjs
  team-communication.mjs
  ocr-review.mjs
  ultra-review-report.mjs
  governance-graph.mjs
  remote-paseo.mjs
  model-routing.mjs
  team-scripts-path.mjs
  eod-digest.mjs
  preflight.mjs
  check-report-gates.mjs
)

# ---------------------------------------------------------------------------
# Runtime: the hook, the policy, the support scripts. This half is HOST-wide by
# construction — the provider config points PASEO_TEAM_SCRIPTS_DIR and
# PASEO_TEAM_STATE_DIR at absolute paths and the bash allowlist compares full
# paths, so it cannot be made per-project. --skills-only skips it for the
# 2nd..Nth project, where it is already installed.
# ---------------------------------------------------------------------------
if [[ "$SKILLS_ONLY" -eq 0 ]]; then

mkdir -p "$CLAUDE_TEAM_DIR/prompts" "$CLAUDE_TEAM_DIR/scripts" "$CLAUDE_TEAM_DIR/state"
chmod 700 "$CLAUDE_TEAM_DIR/state"
mkdir -p "$HOME/.paseo-claude-team"

# The hook imports ./claude-policy.mts, which imports ./policy-core.mts.
# Shipping one without the others breaks the runtime at import time.
cp -f "$ROLE_PACK_ROOT/extensions/claude-team-hook.mjs" "$CLAUDE_TEAM_DIR/"
cp -f "$ROLE_PACK_ROOT/extensions/claude-policy.mts" "$CLAUDE_TEAM_DIR/"
cp -f "$ROLE_PACK_ROOT/extensions/policy-core.mts" "$CLAUDE_TEAM_DIR/"
chmod +x "$CLAUDE_TEAM_DIR/claude-team-hook.mjs"

cp -f "$ROLE_PACK_ROOT"/prompts/*.md "$CLAUDE_TEAM_DIR/prompts/"
for support_file in "${TEAM_SUPPORT_FILES[@]}"; do
  cp -f "$ROLE_PACK_ROOT/scripts/$support_file" "$CLAUDE_TEAM_DIR/scripts/"
done

# Hook wiring with the absolute path resolved. Written as its own settings file
# so ~/.claude/settings.json is never rewritten.
CLAUDE_SETTINGS="$CLAUDE_TEAM_DIR/settings.claude-team.json"
HOOK_PATH="$CLAUDE_TEAM_DIR/claude-team-hook.mjs"
node -e '
const { writeFileSync } = require("node:fs");
const [out, hook] = process.argv.slice(1);
const entry = { matcher: "*", hooks: [{ type: "command", command: hook }] };
writeFileSync(out, JSON.stringify({ hooks: {
  SessionStart: [entry], UserPromptSubmit: [entry],
  PreToolUse: [entry], SessionEnd: [entry],
} }, null, 2) + "\n");
' "$CLAUDE_SETTINGS" "$HOOK_PATH"

# Install provenance: the deployed manifest.json carries the pack version and
# policy digest; the git commit message below is derived from the DEPLOYED
# copy, so the recorded digest is the one that actually landed on disk.
cp -f "$ROLE_PACK_ROOT/manifest.json" "$CLAUDE_TEAM_DIR/"

# Deployed-config git versioning (P0). The deploy dir carries live routing and
# policy, so every install/refresh must land as a revertable commit. Without
# git we degrade LOUDLY — a WARNING and exit 0, never a silent unversioned
# deploy. The repo is created in the deploy dir and nowhere else.
if command -v git >/dev/null 2>&1; then
  PACK_VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$CLAUDE_TEAM_DIR/manifest.json")"
  PACK_DIGEST="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).policyDigest' "$CLAUDE_TEAM_DIR/manifest.json")"
  # state/ is runtime-mutable (mode 700); it must never enter config history.
  # Append-if-absent: a user's pre-existing .gitignore is their file, never
  # truncated (pack-ship F008).
  if [[ ! -f "$CLAUDE_TEAM_DIR/.gitignore" ]] || ! grep -qx 'state/' "$CLAUDE_TEAM_DIR/.gitignore"; then
    printf 'state/\n' >> "$CLAUDE_TEAM_DIR/.gitignore"
  fi
  VERSIONING_REPO="own"
  if [[ -e "$CLAUDE_TEAM_DIR/.git" ]]; then
    if [[ ! -d "$CLAUDE_TEAM_DIR/.git" ]]; then
      # .git as a FILE means a linked worktree or submodule of some OTHER
      # repository. Committing there would land installer-authored commits in
      # the user's repo — foreign, hands off (pack-ship F008).
      VERSIONING_REPO="foreign"
    else
      TOPLEVEL="$(git -C "$CLAUDE_TEAM_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
      if [[ "$(cd "$CLAUDE_TEAM_DIR" && pwd -P)" != "$(cd "$TOPLEVEL" 2>/dev/null && pwd -P)" ]]; then
        VERSIONING_REPO="foreign"
      fi
    fi
    COMMIT_MESSAGE="refresh $PACK_VERSION $PACK_DIGEST"
  else
    # No .git at all: the deploy dir gets its OWN repo, even nested inside
    # some parent checkout — that is what keeps routing changes revertable.
    git -C "$CLAUDE_TEAM_DIR" init --quiet
    COMMIT_MESSAGE="install $PACK_VERSION $PACK_DIGEST"
  fi
  if [[ "$VERSIONING_REPO" == "foreign" ]]; then
    echo "[paseo-claude-team] WARNING: $CLAUDE_TEAM_DIR belongs to another repository (worktree/submodule/nested checkout) — skipping deployed-config versioning; managing that history is yours" >&2
  else
    # Stage only installer-owned paths — never a user's own files in the
    # deploy dir (pack-ship F008: no blanket add -A).
    git -C "$CLAUDE_TEAM_DIR" add -A -- \
      prompts scripts manifest.json .gitignore \
      claude-team-hook.mjs claude-policy.mts policy-core.mts \
      settings.claude-team.json
    # Pinned identity + signing off so the commit succeeds deterministically on
    # hosts with no global git config; --allow-empty keeps a no-change refresh
    # auditable instead of failing the install.
    git -C "$CLAUDE_TEAM_DIR" \
      -c user.name="paseo-claude-team installer" \
      -c user.email="installer@paseo-claude-team.invalid" \
      -c commit.gpgsign=false \
      commit --quiet --allow-empty -m "$COMMIT_MESSAGE"
    echo "[paseo-claude-team] deployed-config commit: $COMMIT_MESSAGE"
  fi
else
  echo "[paseo-claude-team] WARNING: git not found — deployed config at $CLAUDE_TEAM_DIR is unversioned; routing changes are not revertable" >&2
fi

# OpenCodeReview is a global npm package. It is required only by the
# independent-reviewer OCR workflow; --skip-ocr leaves it out and the wrapper
# then fails closed with OCR_UNAVAILABLE rather than reviewing a guessed file list.
if [[ "$SKIP_OCR" -eq 0 ]]; then
  if ! node "$ROLE_PACK_ROOT/scripts/ocr-setup.mjs"; then
    echo "[paseo-claude-team] OCR setup failed — re-run with --skip-ocr to install without it" >&2
    exit 1
  fi
else
  echo "[paseo-claude-team] skipping OCR CLI (--skip-ocr)"
fi

fi
# --------------------------- end runtime install ---------------------------

# The policy says what an agent MAY do; the skills say HOW the work is run.
# Scope is deliberate: a skill in ~/.claude/skills is offered to every session
# on this host, and most projects here are not SLP projects. Per project by
# default; --global-skills is the explicit escape hatch.
if [[ -n "$SKILLS_TARGET" ]]; then
  mkdir -p "$SKILLS_TARGET"
  for skill in paseo-team-lead paseo-ocr-reviewer paseo-ultra-review paseo-premise-audit repo-refresh; do
    rm -rf "$SKILLS_TARGET/$skill"
    cp -R "$ROLE_PACK_ROOT/skills/$skill" "$SKILLS_TARGET/$skill"
  done
  echo "[paseo-claude-team] skills -> $SKILLS_TARGET"
  if [[ -n "$PROJECT_DIR" ]]; then
    # Peers run in Paseo worktrees, which are separate checkouts. An uncommitted
    # .claude/skills exists in the project root and NOWHERE else, so the Peer
    # that needs the workflow is the one seat that cannot see it. Say so here
    # rather than letting it be discovered as a missing skill mid-dispatch.
    echo "[paseo-claude-team] NOTE: commit .claude/skills/ if Peers will run in Paseo worktrees —"
    echo "                   a worktree is a separate checkout and does not inherit uncommitted files."
  fi
else
  echo "[paseo-claude-team] skills: none installed (by design)."
  echo "                   Onboard a project with: scripts/install.sh --skills-only --project <path>"
fi

echo ""
echo "[paseo-claude-team] Installed:"
if [[ "$SKILLS_ONLY" -eq 0 ]]; then
echo "  runtime  -> $CLAUDE_TEAM_DIR"
echo "  hooks    -> $CLAUDE_SETTINGS"
echo "  prompts  -> $CLAUDE_TEAM_DIR/prompts"
echo "  support  -> $CLAUDE_TEAM_DIR/scripts"
fi
echo "  skills   -> ${SKILLS_TARGET:-(none — per project, see --project)}"
echo ""
if [[ "$SKILLS_ONLY" -eq 1 ]]; then
  if [[ -n "$PROJECT_DIR" ]]; then
    echo "Next step: confirm the project sees them — cd \"$PROJECT_DIR\" && ls .claude/skills"
  else
    echo "Next step: confirm they are visible — ls \"$SKILLS_TARGET\""
  fi
  exit 0
fi
echo "Next steps:"
echo "  1. Merge config/paseo.providers.claude.example.json into ~/.paseo/config.json,"
echo "     replacing <HOME> with $HOME. Keep daemon.mcp.injectIntoAgents: true —"
echo "     without it agents receive no Paseo orchestration tools."
echo "     JSON has no comments, so note here: the per-role \"models\" arrays are"
echo "     an owner-approved allowlist that intentionally REPLACES the runtime"
echo "     catalog — after any provider update, inspect the catalog and smoke-test"
echo "     before widening; never use additionalModels. The built-in \"claude\""
echo "     provider stays ENABLED on purpose: most projects on a real host are"
echo "     plain Claude Code, and disabling the base seat breaks all of them to"
echo "     guard the few that are governed. A Lead on the wrong seat is DETECTED"
echo "     by governance-graph, not prevented here."
echo "  2. Apply provider changes with 'paseo daemon reload' IMMEDIATELY after the edit."
echo "     provider-snapshot-manager rewrites config.json on every refresh (daemon start,"
echo "     and whenever the desktop app reconnects), so an edit the running daemon never"
echo "     loaded is silently clobbered. 'restart' kills running agents."
echo "  3. Confirm the providers: paseo provider ls | grep claude-"
echo ""
echo "     The provider env must point at the directory this installer populated:"
echo "       PASEO_TEAM_SCRIPTS_DIR = $CLAUDE_TEAM_DIR/scripts"
echo "       PASEO_TEAM_STATE_DIR   = $CLAUDE_TEAM_DIR/state"
echo "     The bash allowlist compares FULL paths, so if these diverge the Peer's"
echo "     ask-lead and the watchdog are rejected as unsanctioned commands."
echo "  4. Check host readiness: node \"$ROLE_PACK_ROOT/scripts/preflight.mjs\""
echo "  5. Onboard each SLP project separately (the runtime above is host-wide, the"
echo "     skills are not): copy templates/WORKSPACE_PROTOCOL.example.md to"
echo "     <project>/WORKSPACE_PROTOCOL.md, then"
echo "       scripts/install.sh --skills-only --project <project>"
echo "     Projects you never onboard keep plain Claude Code, untouched. See docs/onboarding.md."
