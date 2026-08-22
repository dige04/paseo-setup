# install.ps1 — install the paseo-claude-team role pack for Claude Code.
#
# Mirrors install.sh. Everything lands in one flat directory so the hook
# resolves ./claude-policy.mts the same way in-repo and installed.
#
# Does NOT touch ~/.claude/settings.json (the wiring is its own settings file
# passed by the provider with --settings), and does NOT write
# ~/.paseo/config.json — merge the provider example by hand.

[CmdletBinding()]
param(
  [switch]$SkipOcr
)

$ErrorActionPreference = "Stop"

$RolePackRoot = Split-Path -Parent $PSScriptRoot
$claudeTeamDir = if ($env:CLAUDE_TEAM_DIR) { $env:CLAUDE_TEAM_DIR } else { Join-Path $env:USERPROFILE ".claude\paseo-team" }
$claudeSkillsDir = if ($env:CLAUDE_SKILLS_DIR) { $env:CLAUDE_SKILLS_DIR } else { Join-Path $env:USERPROFILE ".claude\skills" }
$claudePromptDir = Join-Path $claudeTeamDir "prompts"
$claudeScriptsDir = Join-Path $claudeTeamDir "scripts"

$teamSupportFiles = @(
  # lib-common.mjs must ship: every other support script imports it.
  "lib-common.mjs",
  "reliability.mjs",
  "watchdog.mjs",
  "team-communication.mjs",
  "ocr-review.mjs",
  "ultra-review-report.mjs",
  "remote-paseo.mjs",
  "model-routing.mjs",
  "team-scripts-path.mjs"
)

New-Item -ItemType Directory -Force -Path $claudeTeamDir, $claudePromptDir, $claudeScriptsDir, (Join-Path $claudeTeamDir "state"), $claudeSkillsDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE ".paseo-claude-team") | Out-Null

# The hook imports ./claude-policy.mts, which imports ./policy-core.mts.
foreach ($runtimeFile in @("claude-team-hook.mjs", "claude-policy.mts", "policy-core.mts")) {
  Copy-Item (Join-Path $RolePackRoot "extensions\$runtimeFile") $claudeTeamDir -Force
}
Copy-Item (Join-Path $RolePackRoot "prompts\*.md") $claudePromptDir -Force
foreach ($supportFile in $teamSupportFiles) {
  Copy-Item (Join-Path $RolePackRoot "scripts\$supportFile") $claudeScriptsDir -Force
}

# The policy says what an agent MAY do; the skills say HOW the work is run.
foreach ($skill in @("paseo-team-lead", "paseo-ocr-reviewer", "paseo-ultra-review", "paseo-premise-audit")) {
  $dest = Join-Path $claudeSkillsDir $skill
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse -Force (Join-Path $RolePackRoot "skills\$skill") $dest
}

$claudeSettings = Join-Path $claudeTeamDir "settings.claude-team.json"
$hookPath = Join-Path $claudeTeamDir "claude-team-hook.mjs"
$hookEntry = @{ matcher = "*"; hooks = @(@{ type = "command"; command = $hookPath }) }
@{ hooks = @{
    SessionStart     = @($hookEntry)
    UserPromptSubmit = @($hookEntry)
    PreToolUse       = @($hookEntry)
    SessionEnd       = @($hookEntry)
} } | ConvertTo-Json -Depth 8 | Set-Content -Path $claudeSettings -Encoding utf8

# OpenCodeReview is a global npm package, needed only by the OCR reviewer flow.
if (-not $SkipOcr) {
  & node (Join-Path $RolePackRoot "scripts\ocr-setup.mjs")
  if ($LASTEXITCODE -ne 0) {
    Write-Error "[paseo-claude-team] OCR setup failed - re-run with -SkipOcr to install without it"
    exit 1
  }
} else {
  Write-Host "[paseo-claude-team] skipping OCR CLI (-SkipOcr)"
}

Write-Host ""
Write-Host "[paseo-claude-team] Installed:"
Write-Host "  runtime  -> $claudeTeamDir"
Write-Host "  hooks    -> $claudeSettings"
Write-Host "  prompts  -> $claudePromptDir"
Write-Host "  support  -> $claudeScriptsDir"
Write-Host "  skills   -> $claudeSkillsDir\paseo-team-lead, paseo-ocr-reviewer, paseo-ultra-review, paseo-premise-audit"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Merge config/paseo.providers.claude.example.json into ~/.paseo/config.json,"
Write-Host "     replacing <HOME> with $env:USERPROFILE. Keep daemon.mcp.injectIntoAgents: true."
Write-Host "  2. Restart the Paseo daemon when NO agent is running: paseo daemon restart"
Write-Host "  3. Confirm the providers: paseo provider ls"
Write-Host ""
Write-Host "     The provider env must point at the directory this installer populated:"
Write-Host "       PASEO_TEAM_SCRIPTS_DIR = $claudeScriptsDir"
Write-Host "       PASEO_TEAM_STATE_DIR   = $(Join-Path $claudeTeamDir 'state')"
Write-Host "     The bash allowlist compares FULL paths; if these diverge the Peer's"
Write-Host "     ask-lead and the watchdog are rejected as unsanctioned commands."
Write-Host "  4. Check host readiness: node `"$(Join-Path $RolePackRoot 'scripts\preflight.mjs')`""
