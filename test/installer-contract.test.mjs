// Installer contract checks: installed support scripts must be usable from an
// unrelated project cwd and must include remote-paseo dependencies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule as isRemoteMain } from "../scripts/remote-paseo.mjs";
import { isMainModule as isRoutingMain } from "../scripts/model-routing.mjs";
import { isMainModule as isOcrMain } from "../scripts/ocr-setup.mjs";
import { isMainModule as isOcrReviewMain } from "../scripts/ocr-review.mjs";
import { isMainModule as isUltraReviewMain } from "../scripts/ultra-review-report.mjs";
import { isMainModule as isCommunicationMain } from "../scripts/team-communication.mjs";
import { isMainModule as isWatchdogMain } from "../scripts/watchdog.mjs";
import { isMainModule as isWakeTierMain } from "../scripts/wake-tier.mjs";
import { isMainModule as isPathMain } from "../scripts/team-scripts-path.mjs";
import { defaultTeamScriptsDir, resolveTeamScriptsDir } from "../scripts/team-scripts-path.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "scripts");
const installed = mkdtempSync(join(tmpdir(), "paseo-installed-support-"));
const unrelatedCwd = mkdtempSync(join(tmpdir(), "paseo-unrelated-cwd-"));
for (const file of ["lib-common.mjs", "remote-paseo.mjs", "model-routing.mjs", "reliability.mjs", "reconcile-core.mjs", "reconcile-observer.mjs", "policy-digest.mjs", "team-communication.mjs", "watchdog.mjs", "wake-tier.mjs", "ocr-review.mjs", "ocr-setup.mjs", "ultra-review-report.mjs", "team-scripts-path.mjs"]) {
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
  [join(installed, "ultra-review-report.mjs"), isUltraReviewMain],
  [join(installed, "team-communication.mjs"), isCommunicationMain],
  [join(installed, "watchdog.mjs"), isWatchdogMain],
  [join(installed, "wake-tier.mjs"), isWakeTierMain],
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
  if (target.endsWith("ultra-review-report.mjs")) {
    const symlinkOutput = execFileSync(process.execPath, [link, "--help"], {
      cwd: unrelatedCwd,
      env,
      encoding: "utf8",
    });
    assert.match(symlinkOutput, /ultra-review-report\.mjs/);
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
  for (const script of ["team-communication.mjs", "watchdog.mjs", "wake-tier.mjs"]) {
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
  for (const skill of ["paseo-team-lead", "paseo-ocr-reviewer", "paseo-ultra-review", "paseo-premise-audit", "repo-refresh"]) {
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

// A skill that points at a reference file must ship that file. A dangling
// pointer is the mechanism-free claim the premise-audit catalog warns about:
// the skill promises a domain profile that does not exist, and the agent
// silently proceeds without it.
{
	const linkRe = /\]\((references\/[a-z0-9./-]+\.md)\)/g;
	for (const skill of ["paseo-ultra-review", "paseo-premise-audit"]) {
		const skillDir = join(root, "skills", skill);
		const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
		for (const [, target] of body.matchAll(linkRe)) {
			assert.ok(
				existsSync(join(skillDir, target)),
				`skills/${skill}/SKILL.md links ${target}, which does not exist`,
			);
		}
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

// ---------------------------------------------------------------------------
// Provider config hardening. Each role provider must carry an owner-approved
// "models" allowlist (Paseo custom-provider shape: [{id, label}]), and the
// built-in role-less "claude" provider must be disabled. The allowlist
// intentionally REPLACES the runtime catalog, so any drift here is a routing
// change, not cosmetics — the expected sets are asserted exactly, order
// included, because the first entry is the default a human reaches for.
// ---------------------------------------------------------------------------
{
	const examplePath = join(root, "config", "paseo.providers.claude.example.json");
	const exampleText = readFileSync(examplePath, "utf8");
	const providers = JSON.parse(exampleText)?.agents?.providers ?? {};

	// The built-in "claude" provider stays ENABLED, and that is a decision, not an
	// oversight. This pack shipped `enabled: false` on the theory that a role-less
	// session should be impossible — which is only defensible on a host dedicated
	// to SLP. Real hosts are mixed: most projects here are deliberately plain
	// Claude Code (see docs/onboarding.md, "Should this project use SLP at all?"),
	// and disabling the base seat breaks every one of them to guard against a
	// mistake in the few that are governed. Wrong trade, and it was reported by the
	// owner within a day of shipping.
	//
	// It also never worked: provider-snapshot-manager rewrites config.json on
	// every refresh with built-ins materialised as enabled, so the disable
	// reverted on its own (measured 2026-09-01, twice, once with no daemon
	// restart). A guard that breaks the common case AND silently lapses is worse
	// than no guard, because it reads like one.
	//
	// The real guarantee is detection: governance-graph's enforcementClass
	// separates pack-enforced seats from unenforced ones, so a Lead sitting on the
	// wrong seat is reported rather than prevented. Same posture as every other
	// place this pack meets a seat the hook cannot reach.
	assert.deepEqual(
		providers.claude,
		{ enabled: true },
		'example config must leave the built-in "claude" provider enabled: plain Claude Code projects share this host',
	);

	const expectedModels = {
		"claude-supervisor": [
			// F010: haiku leads this list on purpose — the Supervisor is the
			// cheapest, most-dispatched monitor-only seat, and daily-ops pins it.
			{ id: "claude-haiku-4-5", label: "Haiku 4.5" },
			{ id: "claude-sonnet-5", label: "Sonnet 5" },
			{ id: "claude-opus-5", label: "Opus 5" },
		],
		"claude-lead": [
			{ id: "claude-opus-5", label: "Opus 5" },
			{ id: "claude-sonnet-5", label: "Sonnet 5" },
		],
		"claude-peer": [
			{ id: "claude-sonnet-5", label: "Sonnet 5" },
			{ id: "claude-opus-5", label: "Opus 5" },
			{ id: "claude-haiku-4-5", label: "Haiku 4.5" },
		],
	};
	for (const [role, models] of Object.entries(expectedModels)) {
		const provider = providers[role];
		assert.ok(provider, `example config is missing provider ${role}`);
		assert.equal(provider.extends, "claude", `${role} must extend the disabled built-in provider`);
		assert.ok(Array.isArray(provider.models), `${role} must pin a "models" allowlist array`);
		assert.deepEqual(
			provider.models.map(({ id, label }) => ({ id, label })),
			models,
			`${role} allowlist must be exactly the owner-approved model set`,
		);
	}
	// additionalModels APPENDS to the runtime catalog; the whole point of the
	// allowlist is to REPLACE it. Its mere presence anywhere is a defect.
	assert.ok(
		!exampleText.includes("additionalModels"),
		"example config must never use additionalModels",
	);
}

// ---------------------------------------------------------------------------
// Deployed-config git versioning (P0). Both installers must land every
// install/refresh of the deploy dir as a revertable git commit whose message
// carries the pack version and policy digest from the DEPLOYED manifest.json,
// and must degrade LOUDLY when git is missing — a WARNING line, never a
// silent unversioned deploy. The repo must be bound to the deploy dir
// variable (-C), never created anywhere else.
// ---------------------------------------------------------------------------
{
	// The cp below is only honest if the source manifest actually ships.
	assert.ok(existsSync(join(root, "manifest.json")), "manifest.json is missing from the repo root");

	const sh = installerCode("install.sh");
	assert.ok(sh.includes('cp -f "$ROLE_PACK_ROOT/manifest.json" "$CLAUDE_TEAM_DIR/"'), "install.sh must install manifest.json into the deploy dir");
	assert.ok(sh.includes("command -v git"), "install.sh must probe for git before versioning");
	assert.ok(sh.includes('git -C "$CLAUDE_TEAM_DIR" init'), "install.sh must git-init the deploy dir (and only the deploy dir)");
	// F008: stage installer-owned paths only — a bare `add -A` sweeps user
	// content in the deploy dir into a pack-authored commit.
	assert.ok(sh.includes('git -C "$CLAUDE_TEAM_DIR" add -A -- '), "install.sh must stage with an explicit installer-owned pathspec");
	assert.ok(!/add -A\s*$/m.test(sh), "install.sh must never run a blanket add -A without a pathspec");
	// F008: .git may be a FILE (linked worktree/submodule) — that repo is the
	// user's, and versioning must be skipped loudly, never committed into.
	assert.ok(sh.includes('[[ -e "$CLAUDE_TEAM_DIR/.git" ]]'), "install.sh must detect .git as file OR directory");
	assert.ok(sh.includes("rev-parse --show-toplevel"), "install.sh must verify the deploy dir owns its repo before committing");
	assert.ok(/belongs to another repository/.test(sh), "install.sh must warn and skip on a foreign repo");
	// F008: never truncate a user's .gitignore.
	assert.ok(sh.includes("grep -qx 'state/'"), "install.sh must append state/ to .gitignore only when absent");
	assert.ok(!/printf 'state\/\\n' > /.test(sh), "install.sh must not truncate .gitignore with >");
	assert.ok(sh.includes('COMMIT_MESSAGE="install $PACK_VERSION $PACK_DIGEST"'), "install.sh first commit must record install <version> <policyDigest>");
	assert.ok(sh.includes('COMMIT_MESSAGE="refresh $PACK_VERSION $PACK_DIGEST"'), "install.sh refresh commit must record refresh <version> <policyDigest>");
	assert.ok(sh.includes(".policyDigest"), "install.sh must read the policy digest from the installed manifest (jq-free)");
	assert.ok(/WARNING: git not found[^\n]*not revertable/.test(sh), "install.sh must warn loudly that routing changes are not revertable when git is missing");
	assert.ok(!/^\s*git init\b/m.test(sh), "install.sh must never run an unanchored git init");

	const ps = installerCode("install.ps1");
	assert.ok(ps.includes('Copy-Item (Join-Path $RolePackRoot "manifest.json") $claudeTeamDir -Force'), "install.ps1 must install manifest.json into the deploy dir");
	assert.ok(ps.includes("Get-Command git"), "install.ps1 must probe for git before versioning");
	assert.ok(ps.includes("git -C $claudeTeamDir init"), "install.ps1 must git-init the deploy dir (and only the deploy dir)");
	assert.ok(ps.includes("git -C $claudeTeamDir add -A -- "), "install.ps1 must stage with an explicit installer-owned pathspec");
	assert.ok(!/add -A\s*$/m.test(ps), "install.ps1 must never run a blanket add -A without a pathspec");
	assert.ok(ps.includes("-PathType Container"), "install.ps1 must distinguish .git file (foreign worktree) from directory");
	assert.ok(ps.includes("rev-parse --show-toplevel"), "install.ps1 must verify the deploy dir owns its repo before committing");
	assert.ok(/belongs to another repository/.test(ps), "install.ps1 must warn and skip on a foreign repo");
	assert.ok(ps.includes("Add-Content"), "install.ps1 must append to .gitignore, not truncate it");
	assert.ok(!ps.includes('Set-Content -Path (Join-Path $claudeTeamDir ".gitignore")'), "install.ps1 must not truncate .gitignore with Set-Content");
	assert.ok(ps.includes('$commitMessage = "install $packVersion $packDigest"'), "install.ps1 first commit must record install <version> <policyDigest>");
	assert.ok(ps.includes('$commitMessage = "refresh $packVersion $packDigest"'), "install.ps1 refresh commit must record refresh <version> <policyDigest>");
	assert.ok(ps.includes(".policyDigest"), "install.ps1 must read the policy digest from the installed manifest (jq-free)");
	assert.ok(/WARNING: git not found[^\n]*not revertable/.test(ps), "install.ps1 must warn loudly that routing changes are not revertable when git is missing");
}

// ---------------------------------------------------------------------------
// Reverse direction: every script the pack tells anyone to run from
// PASEO_TEAM_SCRIPTS_DIR must actually be shipped by BOTH installers.
// The forward-only checks above (shipped -> exists, shipped -> deps shipped)
// let eod-digest.mjs go unshipped while the suite stayed green — the round-1
// F006 class, third episode (pack-ship F001). This closes the class, not the
// instance: a new documented entrypoint fails here until it ships.
// ---------------------------------------------------------------------------
{
	// Scripts that may be referenced without shipping (currently none — keep
	// the list explicit so an intentional exception is a visible decision).
	const NOT_SHIPPED = new Set();

	const referenced = new Set();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(md|mjs|mts|json|sh|ps1|yaml)$/.test(entry.name)) {
				const text = readFileSync(path, "utf8");
				for (const match of text.matchAll(/PASEO_TEAM_SCRIPTS_DIR[>/}"'`]*\/([a-z0-9-]+\.mjs)/g)) {
					referenced.add(match[1]);
				}
			}
		}
	};
	for (const dir of ["scripts", "docs", "prompts", "skills", "templates"]) {
		if (existsSync(join(root, dir))) walk(join(root, dir));
	}
	assert.ok(referenced.size >= 5, `reference scan looks broken (found only ${referenced.size} referenced scripts)`);

	for (const installer of ["install.sh", "install.ps1"]) {
		const text = readFileSync(join(root, "scripts", installer), "utf8");
		const shipped = new Set([...text.matchAll(/^\s*"?([a-z0-9-]+\.mjs)"?,?\s*$/gm)].map((m) => m[1]));
		for (const file of referenced) {
			if (NOT_SHIPPED.has(file)) continue;
			assert.ok(shipped.has(file), `${installer}: ${file} is invoked via PASEO_TEAM_SCRIPTS_DIR but is not in the ship list`);
		}
		// The deployed attribution ritual (preflight --version) must work off a
		// deployed host, not only a source checkout.
		assert.ok(shipped.has("preflight.mjs"), `${installer}: preflight.mjs must ship (policy-digest attribution on deployed hosts)`);
	}
}

// ---------------------------------------------------------------------------
// EXECUTION-based contract (F011): the git-versioning behavior above is no
// longer proven by text-matching alone — install.sh actually runs in a
// sandbox. Static asserts would stay green with the logic in a dead branch;
// these cannot. Skipped where bash is unavailable (Windows), where the
// static asserts remain the floor.
// ---------------------------------------------------------------------------
if (process.platform !== "win32") {
	const run = (env) =>
		execFileSync("bash", [join(root, "scripts", "install.sh"), "--skip-ocr"], {
			env: { ...process.env, ...env },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	const gitOut = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

	const sandbox = mkdtempSync(join(tmpdir(), "paseo-install-exec-"));
	const home = join(sandbox, "home");
	mkdirSync(home, { recursive: true });
	const deploy = join(sandbox, "deploy");
	const skills = join(sandbox, "skills");
	const env = { HOME: home, CLAUDE_TEAM_DIR: deploy, CLAUDE_SKILLS_DIR: skills };

	// Fresh install: own repo, install commit, digest recorded.
	run(env);
	assert.match(gitOut(deploy, ["log", "--format=%s", "-1"]), /^install \d+\.\d+\.\d+ sha256:[0-9a-f]{64}$/);
	assert.ok(existsSync(join(deploy, "scripts", "eod-digest.mjs")), "eod-digest.mjs must actually deploy");
	assert.ok(existsSync(join(deploy, "scripts", "preflight.mjs")), "preflight.mjs must actually deploy");

	// Refresh with a user file present: refresh commit, user file NOT swept.
	writeFileSync(join(deploy, "user-notes.txt"), "mine\n");
	run(env);
	assert.match(gitOut(deploy, ["log", "--format=%s", "-1"]), /^refresh /);
	assert.ok(!gitOut(deploy, ["ls-files"]).includes("user-notes.txt"), "installer must not commit user files (F008)");

	// Pre-existing .gitignore must be appended, never truncated.
	writeFileSync(join(deploy, ".gitignore"), "keep-me/\n");
	run(env);
	const ignore = readFileSync(join(deploy, ".gitignore"), "utf8");
	assert.ok(ignore.includes("keep-me/") && ignore.includes("state/"), ".gitignore must keep user lines and gain state/ (F008)");

	// Worktree deploy dir belongs to another repo: skip loudly, parent untouched.
	const parent = join(sandbox, "parent");
	execFileSync("git", ["init", "-q", parent]);
	execFileSync("git", ["-C", parent, "-c", "user.email=u@x", "-c", "user.name=u", "commit", "-q", "--allow-empty", "-m", "base"]);
	const wt = join(sandbox, "wt-deploy");
	execFileSync("git", ["-C", parent, "worktree", "add", "-q", "-b", "wt", wt]);
	const out = run({ HOME: home, CLAUDE_TEAM_DIR: wt, CLAUDE_SKILLS_DIR: join(sandbox, "skills2") });
	void out;
	assert.equal(gitOut(parent, ["rev-list", "--count", "HEAD"]), "1", "foreign worktree parent must gain no commits (F008)");
	assert.ok(!existsSync(join(wt, ".git", "HEAD")) || readFileSync(join(wt, ".git"), "utf8").startsWith("gitdir:"), "worktree .git file must survive untouched");

	// -----------------------------------------------------------------------
	// Skill SCOPE. A skill in ~/.claude/skills is offered to every session on
	// the host, and most projects here are not SLP projects. These run the real
	// installer because the scoping lives entirely in its control flow: a text
	// assert would stay green with the copy in a dead branch.
	// -----------------------------------------------------------------------
	const runArgs = (env, args) =>
		execFileSync("bash", [join(root, "scripts", "install.sh"), ...args], {
			env: { ...process.env, ...env },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	const packSkills = ["paseo-team-lead", "paseo-ocr-reviewer", "paseo-ultra-review", "paseo-premise-audit", "repo-refresh"];

	// The three installs above ran with no --project and no --global-skills.
	// None of them may have written a global skill.
	for (const skill of packSkills) {
		assert.ok(
			!existsSync(join(skills, skill)),
			`a default install must not put ${skill} in the global skills dir`,
		);
	}

	// WORKSPACE_PROTOCOL.md is the opt-in. Without it the installer refuses,
	// and — the part that matters — writes nothing.
	const proj = join(sandbox, "project");
	mkdirSync(proj, { recursive: true });
	assert.throws(
		() => runArgs(env, ["--skip-ocr", "--skills-only", "--project", proj]),
		(error) => /WORKSPACE_PROTOCOL\.md/.test(String(error.stderr)),
		"a project with no protocol file must be refused",
	);
	assert.ok(!existsSync(join(proj, ".claude")), "a refused onboard must leave no partial install");

	// The template documents .orchestration/, so that location must satisfy the
	// opt-in too — a check that only accepts the root would teach people to
	// bypass it rather than to write the contract.
	mkdirSync(join(proj, ".orchestration"), { recursive: true });
	writeFileSync(join(proj, ".orchestration", "WORKSPACE_PROTOCOL.md"), "# scopes\n");
	runArgs(env, ["--skip-ocr", "--skills-only", "--project", proj]);
	assert.ok(existsSync(join(proj, ".claude", "skills", "paseo-team-lead", "SKILL.md")), ".orchestration/ must count as opt-in");

	// The repo root is the second accepted location.
	const proj2 = join(sandbox, "project-root-protocol");
	mkdirSync(proj2, { recursive: true });
	writeFileSync(join(proj2, "WORKSPACE_PROTOCOL.md"), "# scopes\n");
	runArgs(env, ["--skip-ocr", "--skills-only", "--project", proj2]);
	for (const skill of packSkills) {
		assert.ok(existsSync(join(proj2, ".claude", "skills", skill, "SKILL.md")), `${skill} must reach the project`);
		assert.ok(!existsSync(join(skills, skill)), `${skill} must not leak to the global dir`);
	}
	// --skills-only must not have re-run the runtime half: no new deploy commit.
	assert.match(gitOut(deploy, ["log", "--format=%s", "-1"]), /^refresh /);

	// --global-skills is the explicit escape hatch, and the uninstall reverses
	// exactly it — the pack's five directories, and nothing neighbouring.
	runArgs(env, ["--skip-ocr", "--skills-only", "--global-skills"]);
	for (const skill of packSkills) assert.ok(existsSync(join(skills, skill)), `${skill} must honour --global-skills`);
	mkdirSync(join(skills, "somebody-elses-skill"), { recursive: true });
	writeFileSync(join(skills, "somebody-elses-skill", "SKILL.md"), "not ours\n");
	runArgs(env, ["--uninstall-global-skills"]);
	for (const skill of packSkills) assert.ok(!existsSync(join(skills, skill)), `${skill} must be removed globally`);
	assert.ok(
		existsSync(join(skills, "somebody-elses-skill", "SKILL.md")),
		"the uninstall removes the pack's skills only, never a neighbour's",
	);
	assert.ok(existsSync(join(deploy, "scripts", "wake-tier.mjs")), "the runtime survives a skills uninstall");
}

console.log("installer contract tests passed");
