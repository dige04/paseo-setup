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
#   ~/.claude/skills/paseo-team-lead, paseo-ocr-reviewer, paseo-ultra-review, paseo-premise-audit
#
# It does NOT touch ~/.claude/settings.json: the hook wiring lives in its own
# settings file that the Paseo provider passes with --settings, so a plain
# `claude` session is unaffected. It also does NOT write ~/.paseo/config.json —
# merge config/paseo.providers.claude.example.json by hand, so the change stays
# under your control.

set -euo pipefail

SKIP_OCR=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-ocr) SKIP_OCR=1; shift ;;
    -h|--help)
      echo "usage: install.sh [--skip-ocr]"
      echo "  --skip-ocr   do not install the OpenCodeReview CLI (a global npm package)"
      exit 0 ;;
    *) echo "[paseo-claude-team] unknown argument: $1" >&2; exit 1 ;;
  esac
done

ROLE_PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_TEAM_DIR="${CLAUDE_TEAM_DIR:-$HOME/.claude/paseo-team}"
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

TEAM_SUPPORT_FILES=(
  # lib-common.mjs must ship: every other support script imports it as
  # "./lib-common.mjs" and would fail at import time without it.
  lib-common.mjs
  reliability.mjs
  watchdog.mjs
  team-communication.mjs
  ocr-review.mjs
  ultra-review-report.mjs
  governance-graph.mjs
  remote-paseo.mjs
  model-routing.mjs
  team-scripts-path.mjs
)

mkdir -p "$CLAUDE_TEAM_DIR/prompts" "$CLAUDE_TEAM_DIR/scripts" "$CLAUDE_TEAM_DIR/state" "$CLAUDE_SKILLS_DIR"
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

# The policy says what an agent MAY do; the skills say HOW the work is run.
for skill in paseo-team-lead paseo-ocr-reviewer paseo-ultra-review paseo-premise-audit; do
  rm -rf "$CLAUDE_SKILLS_DIR/$skill"
  cp -R "$ROLE_PACK_ROOT/skills/$skill" "$CLAUDE_SKILLS_DIR/$skill"
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

echo ""
echo "[paseo-claude-team] Installed:"
echo "  runtime  -> $CLAUDE_TEAM_DIR"
echo "  hooks    -> $CLAUDE_SETTINGS"
echo "  prompts  -> $CLAUDE_TEAM_DIR/prompts"
echo "  support  -> $CLAUDE_TEAM_DIR/scripts"
echo "  skills   -> $CLAUDE_SKILLS_DIR/paseo-team-lead, paseo-ocr-reviewer, paseo-ultra-review, paseo-premise-audit"
echo ""
echo "Next steps:"
echo "  1. Merge config/paseo.providers.claude.example.json into ~/.paseo/config.json,"
echo "     replacing <HOME> with $HOME. Keep daemon.mcp.injectIntoAgents: true —"
echo "     without it agents receive no Paseo orchestration tools."
echo "  2. Restart the Paseo daemon when NO agent is running: paseo daemon restart"
echo "     (there is no reload; providers are read at startup)."
echo "  3. Confirm the providers: paseo provider ls | grep claude-"
echo ""
echo "     The provider env must point at the directory this installer populated:"
echo "       PASEO_TEAM_SCRIPTS_DIR = $CLAUDE_TEAM_DIR/scripts"
echo "       PASEO_TEAM_STATE_DIR   = $CLAUDE_TEAM_DIR/state"
echo "     The bash allowlist compares FULL paths, so if these diverge the Peer's"
echo "     ask-lead and the watchdog are rejected as unsanctioned commands."
echo "  4. Check host readiness: node \"$ROLE_PACK_ROOT/scripts/preflight.mjs\""
