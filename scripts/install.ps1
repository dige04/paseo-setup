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
  "reconcile-core.mjs",
  "reconcile-observer.mjs",
  "policy-digest.mjs",
  "watchdog.mjs",
  "team-communication.mjs",
  "ocr-review.mjs",
  "ultra-review-report.mjs",
  "governance-graph.mjs",
  "remote-paseo.mjs",
  "model-routing.mjs",
  "team-scripts-path.mjs",
  "eod-digest.mjs",
  "preflight.mjs",
  "check-report-gates.mjs"
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
foreach ($skill in @("paseo-team-lead", "paseo-ocr-reviewer", "paseo-ultra-review", "paseo-premise-audit", "repo-refresh")) {
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

# Install provenance: the deployed manifest.json carries the pack version and
# policy digest; the git commit message below is derived from the DEPLOYED copy.
Copy-Item (Join-Path $RolePackRoot "manifest.json") $claudeTeamDir -Force

# Deployed-config git versioning (P0). Mirrors install.sh: every install or
# refresh of the deploy dir lands as a revertable commit. Without git, degrade
# LOUDLY - a WARNING and exit 0, never a silent unversioned deploy. The repo is
# created in the deploy dir and nowhere else.
if (Get-Command git -ErrorAction SilentlyContinue) {
  $manifestPath = Join-Path $claudeTeamDir "manifest.json"
  $readManifest = "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))"
  $packVersion = (& node -p "$readManifest.version" $manifestPath).Trim()
  $packDigest = (& node -p "$readManifest.policyDigest" $manifestPath).Trim()
  # state/ is runtime-mutable; it must never enter config history.
  # Append-if-absent: a user's pre-existing .gitignore is their file, never
  # truncated (pack-ship F008).
  $gitignorePath = Join-Path $claudeTeamDir ".gitignore"
  $needsStateLine = $true
  if (Test-Path $gitignorePath) {
    $existing = Get-Content $gitignorePath -ErrorAction SilentlyContinue
    if ($existing -contains "state/") { $needsStateLine = $false }
  }
  if ($needsStateLine) { Add-Content -Path $gitignorePath -Value "state/" -Encoding utf8 }
  $versioningRepo = "own"
  $gitEntry = Join-Path $claudeTeamDir ".git"
  if (Test-Path $gitEntry) {
    if (-not (Test-Path $gitEntry -PathType Container)) {
      # .git as a FILE means a linked worktree or submodule of some OTHER
      # repository — foreign, hands off (pack-ship F008).
      $versioningRepo = "foreign"
    } else {
      $topLevel = (& git -C $claudeTeamDir rev-parse --show-toplevel 2>$null)
      if ($LASTEXITCODE -ne 0 -or -not $topLevel) { $versioningRepo = "foreign" }
      else {
        $resolvedDir = (Resolve-Path $claudeTeamDir).Path.TrimEnd('\','/')
        $resolvedTop = (Resolve-Path $topLevel.Trim()).Path.TrimEnd('\','/')
        if ($resolvedDir -ne $resolvedTop) { $versioningRepo = "foreign" }
      }
    }
    $commitMessage = "refresh $packVersion $packDigest"
  } else {
    # No .git at all: the deploy dir gets its OWN repo, even nested inside
    # some parent checkout — that is what keeps routing changes revertable.
    & git -C $claudeTeamDir init --quiet
    if ($LASTEXITCODE -ne 0) { Write-Error "[paseo-claude-team] git init failed in $claudeTeamDir"; exit 1 }
    $commitMessage = "install $packVersion $packDigest"
  }
  if ($versioningRepo -eq "foreign") {
    Write-Host "[paseo-claude-team] WARNING: $claudeTeamDir belongs to another repository (worktree/submodule/nested checkout) - skipping deployed-config versioning; managing that history is yours"
  } else {
    # Stage only installer-owned paths — never a user's own files in the
    # deploy dir (pack-ship F008: no blanket add -A).
    & git -C $claudeTeamDir add -A -- prompts scripts manifest.json .gitignore claude-team-hook.mjs claude-policy.mts policy-core.mts settings.claude-team.json
    # Pinned identity + signing off so the commit succeeds deterministically on
    # hosts with no global git config; --allow-empty keeps a no-change refresh
    # auditable instead of failing the install.
    & git -C $claudeTeamDir -c user.name="paseo-claude-team installer" -c user.email="installer@paseo-claude-team.invalid" -c commit.gpgsign=false commit --quiet --allow-empty -m $commitMessage
    if ($LASTEXITCODE -ne 0) { Write-Error "[paseo-claude-team] deployed-config git commit failed"; exit 1 }
    Write-Host "[paseo-claude-team] deployed-config commit: $commitMessage"
  }
} else {
  Write-Host "[paseo-claude-team] WARNING: git not found - deployed config at $claudeTeamDir is unversioned; routing changes are not revertable"
}

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
Write-Host "     JSON has no comments, so note here: the per-role 'models' arrays are an"
Write-Host "     owner-approved allowlist that intentionally REPLACES the runtime catalog -"
Write-Host "     after any provider update, inspect the catalog and smoke-test before"
Write-Host "     widening; never use additionalModels. The built-in 'claude' provider is"
Write-Host "     disabled so a role-less session cannot start by accident; the three role"
Write-Host "     providers extend it and keep working."
Write-Host "  2. Restart the Paseo daemon when NO agent is running: paseo daemon restart"
Write-Host "  3. Confirm the providers: paseo provider ls"
Write-Host ""
Write-Host "     The provider env must point at the directory this installer populated:"
Write-Host "       PASEO_TEAM_SCRIPTS_DIR = $claudeScriptsDir"
Write-Host "       PASEO_TEAM_STATE_DIR   = $(Join-Path $claudeTeamDir 'state')"
Write-Host "     The bash allowlist compares FULL paths; if these diverge the Peer's"
Write-Host "     ask-lead and the watchdog are rejected as unsanctioned commands."
Write-Host "  4. Check host readiness: node `"$(Join-Path $RolePackRoot 'scripts\preflight.mjs')`""
