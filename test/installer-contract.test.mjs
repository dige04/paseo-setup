// Installer contract checks: installed support scripts must be usable from an
// unrelated project cwd and must include remote-paseo dependencies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule as isRemoteMain } from "../scripts/remote-paseo.mjs";
import { isMainModule as isRoutingMain } from "../scripts/model-routing.mjs";
import { isMainModule as isOcrMain } from "../scripts/ocr-setup.mjs";
import { isMainModule as isOcrReviewMain } from "../scripts/ocr-review.mjs";
import { isMainModule as isCommunicationMain } from "../scripts/team-communication.mjs";
import { isMainModule as isWatchdogMain } from "../scripts/watchdog.mjs";
import { isMainModule as isPathMain } from "../scripts/team-scripts-path.mjs";
import { defaultTeamScriptsDir, resolveTeamScriptsDir } from "../scripts/team-scripts-path.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "scripts");
const installed = mkdtempSync(join(tmpdir(), "paseo-installed-support-"));
const unrelatedCwd = mkdtempSync(join(tmpdir(), "paseo-unrelated-cwd-"));
for (const file of ["lib-common.mjs", "remote-paseo.mjs", "model-routing.mjs", "reliability.mjs", "team-communication.mjs", "watchdog.mjs", "ocr-review.mjs", "ocr-setup.mjs", "team-scripts-path.mjs"]) {
  cpSync(join(source, file), join(installed, file));
}

// Every file the installers ship must exist in scripts/, and every support
// script an installed file imports must itself be shipped — otherwise the
// install succeeds and then fails at import time on the user's machine.
for (const installer of ["install.sh", "install.ps1"]) {
  const text = readFileSync(join(root, "scripts", installer), "utf8");
  const shipped = new Set([...text.matchAll(/^\s*"?([a-z0-9-]+\.mjs)"?,?\s*$/gm)].map((m) => m[1]));
  // Sanity floor only — proves the regex still matches the installer's list
  // shape. The real check is the dependency loop below, not this count.
  assert.ok(shipped.size >= 4, `${installer}: support-file list not found (${shipped.size} matches)`);
  for (const file of shipped) {
    assert.ok(existsSync(join(source, file)), `${installer} ships missing scripts/${file}`);
    const body = readFileSync(join(source, file), "utf8");
    for (const [, dep] of body.matchAll(/from "\.\/([a-z0-9-]+\.mjs)"/g)) {
      assert.ok(shipped.has(dep), `${installer}: ${file} imports ./${dep}, which is not shipped`);
    }
  }
}

const env = { ...process.env, PASEO_TEAM_SCRIPTS_DIR: installed };
assert.equal(resolveTeamScriptsDir({ PASEO_TEAM_SCRIPTS_DIR: installed }), installed);
// This default is load-bearing: claude-policy.mts compares FULL paths, so the
// installer, the provider env and this resolver must agree or the Peer's
// sanctioned ask-lead command is rejected as unsanctioned.
assert.equal(
  defaultTeamScriptsDir({ CLAUDE_TEAM_DIR: "/custom/paseo-team" }),
  join("/custom/paseo-team", "scripts"),
);
assert.equal(
  defaultTeamScriptsDir({ HOME: "/home/u" }).endsWith(join(".claude", "paseo-team", "scripts")),
  true,
);
const installedRemotePath = join(installed, "remote-paseo.mjs");
assert.equal(env.PASEO_TEAM_SCRIPTS_DIR, installed);
const output = execFileSync(process.execPath, [installedRemotePath, "--help"], {
  cwd: unrelatedCwd,
  env: { ...env, PASEO_TEAM_HOME: join(unrelatedCwd, "config") },
  encoding: "utf8",
});
assert.match(output, /remote-paseo\.mjs/);

// macOS temporary directories may be addressed through /var or /private/var.
// Entrypoint detection must compare canonical filesystem paths, not URL text.
const symlinkCases = [
  [join(installed, "remote-paseo.mjs"), isRemoteMain],
  [join(installed, "model-routing.mjs"), isRoutingMain],
  [join(installed, "ocr-setup.mjs"), isOcrMain],
  [join(installed, "ocr-review.mjs"), isOcrReviewMain],
  [join(installed, "team-communication.mjs"), isCommunicationMain],
  [join(installed, "watchdog.mjs"), isWatchdogMain],
  [join(installed, "team-scripts-path.mjs"), isPathMain],
];
for (const [target, isMain] of symlinkCases) {
  const link = join(installed, `link-${target.split(/[\\\\/]/).pop()}`);
  try {
    symlinkSync(target, link, "file");
  } catch (error) {
    if (process.platform !== "win32") throw error;
    continue;
  }
  assert.equal(
    isMain(link, pathToFileURL(target).href),
    true,
    `symlink entrypoint should resolve: ${target}`,
  );
  if (target.endsWith("remote-paseo.mjs")) {
    const symlinkOutput = execFileSync(process.execPath, [link, "--help"], {
      cwd: unrelatedCwd,
      env: { ...env, PASEO_TEAM_HOME: join(unrelatedCwd, "config") },
      encoding: "utf8",
    });
    assert.match(symlinkOutput, /remote-paseo\.mjs/);
  }
  if (target.endsWith("ocr-review.mjs")) {
    const symlinkOutput = execFileSync(process.execPath, [link, "--help"], {
      cwd: unrelatedCwd,
      env,
      encoding: "utf8",
    });
    assert.match(symlinkOutput, /ocr-review\.mjs/);
  }
  if (target.endsWith("team-scripts-path.mjs")) {
    const resolvedOutput = execFileSync(process.execPath, [link], {
      cwd: unrelatedCwd,
      env: { ...env, PI_CODING_AGENT_DIR: "/canonical/pi/agent" },
      encoding: "utf8",
    });
    assert.equal(resolvedOutput.trim(), installed);
  }
}

const installedRemote = readFileSync(join(installed, "remote-paseo.mjs"), "utf8");
assert.match(installedRemote, /from "\.\/model-routing\.mjs"/);
assert.match(installedRemote, /from "\.\/reliability\.mjs"/);


// ---------------------------------------------------------------------------
// Runtime bindings and the shared policy core must ship together. The Pi
// extension imports ./policy-core.mts and the Claude hook imports both
// ./claude-policy.mts and ./policy-core.mts, so shipping one without the other
// breaks the runtime at import time — silently, until the first tool call.
// ---------------------------------------------------------------------------

/**
 * Installer text with comment lines removed. Both installers list the files
 * they copy in a header comment, so an includes() check against the raw text
 * passes even when the actual copy command has been deleted.
 */
function installerCode(name) {
  return readFileSync(join(root, "scripts", name), "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const runtimeImportRe = /from "\.\/([a-z0-9-]+\.mts)"/g;
const runtimeEntrypoints = {
  "claude-team-hook.mjs": ["claude"],
  "claude-policy.mts": ["claude"],
};

for (const [entry, targets] of Object.entries(runtimeEntrypoints)) {
  const body = readFileSync(join(root, "extensions", entry), "utf8");
  for (const [, dep] of body.matchAll(runtimeImportRe)) {
    assert.ok(
      existsSync(join(root, "extensions", dep)),
      `${entry} imports ${dep}, which does not exist in extensions/`,
    );
    for (const installer of ["install.sh", "install.ps1"]) {
      assert.ok(
        installerCode(installer).includes(dep),
        `${installer} must copy ${dep} — ${entry} imports it and would fail at import time`,
      );
    }
  }
}

// Both installers must place the Claude runtime; a POSIX-only port would leave
// Windows hosts with a provider that points at a hook that was never copied.
for (const installer of ["install.sh", "install.ps1"]) {
  const text = installerCode(installer);
  for (const required of [
    "claude-team-hook.mjs",
    "claude-policy.mts",
    "policy-core.mts",
    "settings.claude-team.json",
  ]) {
    assert.ok(text.includes(required), `${installer} must install ${required}`);
  }
}

// The Claude hook reaches the support scripts through an exact bash form, so
// the scripts it names must actually be shipped.
{
  // The allowlist spells the names inside regex literals ("watchdog\\.mjs"),
  // so compare against the unescaped text.
  const claudePolicy = readFileSync(join(root, "extensions", "claude-policy.mts"), "utf8").replace(/\\/g, "");
  for (const script of ["team-communication.mjs", "watchdog.mjs"]) {
    assert.ok(
      claudePolicy.includes(script),
      `claude-policy.mts must allowlist ${script} explicitly`,
    );
    assert.ok(
      existsSync(join(source, script)),
      `${script} is allowlisted by claude-policy.mts but missing from scripts/`,
    );
  }
}

// The policy governs; the skills are the procedure. A Claude Lead without
// paseo-team-lead is governed but has no orchestration workflow, and a Claude
// reviewer holds ocr-review.mjs with nothing telling it how to use it.
// Assert on the LOOP that does the copying, not on substring presence: both
// skills also appear in the pi install lines and in the summary echo, so a blob
// search passes even when the Claude loop no longer copies them.
const CLAUDE_SKILL_LOOP = {
  "install.sh": /^\s*for skill in ([a-z0-9 -]+); do\s*$/m,
  "install.ps1": /^\s*foreach \(\$skill in @\(([^)]*)\)\)\s*\{\s*$/m,
};
for (const [installer, pattern] of Object.entries(CLAUDE_SKILL_LOOP)) {
  const match = installerCode(installer).match(pattern);
  assert.ok(match, `${installer} has no Claude skills install loop`);
  for (const skill of ["paseo-team-lead", "paseo-ocr-reviewer"]) {
    assert.ok(
      existsSync(join(root, "skills", skill, "SKILL.md")),
      `skills/${skill}/SKILL.md is missing from the repo`,
    );
    assert.ok(
      match[1].includes(skill),
      `${installer}'s Claude skills loop must copy ${skill}`,
    );
  }
}

// A shared skill must not hard-code one runtime's provider family: naming only
// pi-* sends a Claude Lead to create agents on a provider that is not installed.
{
  const leadSkill = readFileSync(join(root, "skills", "paseo-team-lead", "SKILL.md"), "utf8");
  const providerLine = leadSkill
    .split(/\r?\n/)
    .find((line) => line.includes("ASSIGNED_PASEO_PROVIDER:"));
  assert.ok(providerLine, "the lead skill must document ASSIGNED_PASEO_PROVIDER");
  assert.ok(
    /claude-/.test(providerLine) || /THIS runtime/.test(providerLine),
    "ASSIGNED_PASEO_PROVIDER must not name only the pi-* provider family",
  );
}

console.log("installer contract tests passed");
