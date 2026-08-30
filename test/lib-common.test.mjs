// Tests for the helpers shared by the support scripts. These used to exist as
// six near-identical private copies; the behaviours pinned here are the ones
// that differed between those copies and are therefore easy to regress.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { homedir } from "node:os";

import {
  PASEO_CONVENTIONAL_ENTRIES,
  compareOcrVersions,
  findOnPath,
  isEntrypoint,
  leadWriteEnabled,
  normalizePaseoCwd,
  parseOcrVersion,
  resolveCanonicalCwds,
  resolveCmdEntry,
  resolvePaseoExec,
  searchPathDirs,
  splitCommandLine,
} from "../scripts/lib-common.mjs";

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const isWindows = process.platform === "win32";

// --- splitCommandLine --------------------------------------------------------

// The regression this whole helper exists for: team-communication.mjs used
// `override.split(/\s+/)`, which shredded any quoted path containing spaces
// into separate argv elements and made the spawn fail with ENOENT.
assert.deepEqual(
  splitCommandLine('"C:\\Program Files\\paseo\\paseo.exe"').parts,
  ["C:\\Program Files\\paseo\\paseo.exe"],
  "a quoted path with spaces stays ONE argv element",
);
assert.deepEqual(
  splitCommandLine('node "C:\\Program Files\\p\\cli.js" --json').parts,
  ["node", "C:\\Program Files\\p\\cli.js", "--json"],
);
assert.deepEqual(splitCommandLine("'/usr/local/my paseo'").parts, [
  "/usr/local/my paseo",
]);
assert.deepEqual(splitCommandLine("  paseo   --json  ").parts, [
  "paseo",
  "--json",
]);
assert.deepEqual(splitCommandLine("").parts, []);

// Unterminated quotes are reported, never guessed at: the caller maps this
// onto its own error code instead of spawning something half-parsed.
assert.equal(splitCommandLine('"unclosed').unterminated, true);
assert.equal(splitCommandLine("'unclosed").unterminated, true);
assert.equal(splitCommandLine('"closed"').unterminated, false);

// Non-strings throw instead of coercing: String(undefined) would have produced
// the argv element "undefined" and spawned a nonsense binary.
assert.throws(() => splitCommandLine(undefined), TypeError);
assert.throws(() => splitCommandLine(["paseo"]), TypeError);

// --- searchPathDirs / findOnPath ---------------------------------------------

{
  const dirs = searchPathDirs({ PATH: ["a", "", "b"].join(delimiter) });
  assert.deepEqual(dirs, ["a", "b"], "empty PATH entries are dropped");
}

{
  // %APPDATA%\npm holds npm-installed shims and is often missing from a child
  // process's PATH; on Windows it must be searched, elsewhere ignored.
  const dirs = searchPathDirs({ PATH: "a", APPDATA: join("C:", "Users", "x", "AppData") });
  if (isWindows) {
    assert.deepEqual(dirs, ["a", join("C:", "Users", "x", "AppData", "npm")]);
  } else {
    assert.deepEqual(dirs, ["a"]);
  }
}

{
  // Directory-major scan: PATH order decides the winner, not the order of the
  // names. `second.exe` sits earlier on PATH than `first.exe`, so it wins even
  // though "first.exe" is listed first.
  const dirA = tmp("libcommon-path-a-");
  const dirB = tmp("libcommon-path-b-");
  writeFileSync(join(dirA, "second.exe"), "");
  writeFileSync(join(dirB, "first.exe"), "");
  const env = { PATH: [dirA, dirB].join(delimiter) };
  assert.equal(
    findOnPath(["first.exe", "second.exe"], env),
    join(dirA, "second.exe"),
    "earlier PATH dir wins over earlier name",
  );
  assert.equal(findOnPath("first.exe", env), join(dirB, "first.exe"), "accepts a bare string");
  assert.equal(findOnPath(["absent.exe"], env), undefined);
  assert.equal(findOnPath(["absent.exe"], { PATH: "" }), undefined, "empty PATH is not a crash");
}

// --- resolveCmdEntry ---------------------------------------------------------

{
  const shimDir = tmp("libcommon-shim-");
  const entryDir = join(shimDir, "node_modules", "@getpaseo", "cli", "dist");
  mkdirSync(entryDir, { recursive: true });
  const entry = join(entryDir, "index.js");
  writeFileSync(entry, "");

  // npm has emitted both %~dp0 and the older %dp0% form.
  for (const token of ["%~dp0", "%dp0%"]) {
    const shim = join(shimDir, `paseo-${token.replace(/[%~]/g, "")}.cmd`);
    writeFileSync(
      shim,
      `@IF EXIST "${token}\\node_modules\\@getpaseo\\cli\\dist\\index.js" (\n  "${token}\\node_modules\\@getpaseo\\cli\\dist\\index.js" %*\n)\n`,
    );
    assert.equal(resolveCmdEntry(shim), entry, `shim with ${token} resolves`);
  }

  // Unparseable shim → conventional layout beside it.
  const opaque = join(shimDir, "opaque.cmd");
  writeFileSync(opaque, "@echo off\r\nrem nothing quotable here\r\n");
  assert.equal(resolveCmdEntry(opaque), undefined, "no candidates → undefined");
  assert.equal(
    resolveCmdEntry(opaque, PASEO_CONVENTIONAL_ENTRIES),
    entry,
    "falls back to the conventional dist/index.js layout",
  );

  // A shim that points at a file which does not exist must not be trusted.
  const dangling = join(shimDir, "dangling.cmd");
  writeFileSync(dangling, `"%~dp0\\node_modules\\@getpaseo\\cli\\dist\\gone.js" %*\n`);
  assert.equal(resolveCmdEntry(dangling), undefined, "parsed entry must exist on disk");

  assert.equal(resolveCmdEntry(join(shimDir, "no-such-file.cmd")), undefined, "unreadable shim");
}

{
  // Second conventional layout: bin/paseo, shipped by other @getpaseo/cli
  // versions. Without it, team-communication's old resolution would regress.
  const shimDir = tmp("libcommon-shim-bin-");
  const binDir = join(shimDir, "node_modules", "@getpaseo", "cli", "bin");
  mkdirSync(binDir, { recursive: true });
  const entry = join(binDir, "paseo");
  writeFileSync(entry, "");
  const opaque = join(shimDir, "opaque.cmd");
  writeFileSync(opaque, "@echo off\r\n");
  assert.equal(resolveCmdEntry(opaque, PASEO_CONVENTIONAL_ENTRIES), entry);
}

// --- resolvePaseoExec --------------------------------------------------------

{
  const previous = process.env.PASEO_TEAM_PASEO_EXEC;
  const restore = () => {
    if (previous === undefined) delete process.env.PASEO_TEAM_PASEO_EXEC;
    else process.env.PASEO_TEAM_PASEO_EXEC = previous;
  };

  process.env.PASEO_TEAM_PASEO_EXEC = '"C:\\Program Files\\paseo\\paseo.exe" --json';
  assert.deepEqual(
    resolvePaseoExec(),
    ["C:\\Program Files\\paseo\\paseo.exe", "--json"],
    "override keeps a spaced path intact",
  );

  // A malformed override is a hard error, never a silent fall-through to a
  // bare "paseo" that would run a different binary than the operator asked for.
  const seen = [];
  const onInvalid = (reason) => {
    seen.push(reason);
    throw new Error(`mapped: ${reason}`);
  };
  process.env.PASEO_TEAM_PASEO_EXEC = '""';
  assert.throws(() => resolvePaseoExec(onInvalid), /mapped: is set but empty/);
  process.env.PASEO_TEAM_PASEO_EXEC = '"unclosed';
  assert.throws(() => resolvePaseoExec(onInvalid), /mapped: has an unterminated quote/);
  assert.deepEqual(seen, ["is set but empty", "has an unterminated quote"]);

  // Without a mapper it still throws rather than returning something usable.
  assert.throws(() => resolvePaseoExec(), /PASEO_TEAM_PASEO_EXEC/);

  delete process.env.PASEO_TEAM_PASEO_EXEC;
  const resolved = resolvePaseoExec();
  assert.ok(Array.isArray(resolved) && resolved.length >= 1);
  if (!isWindows) {
    assert.deepEqual(resolved, ["paseo"], "non-Windows resolution is the bare name");
  }
  restore();
}

// --- isEntrypoint ------------------------------------------------------------

{
  const dir = tmp("libcommon-entry-");
  const target = join(dir, "module.mjs");
  writeFileSync(target, "export {};\n");
  const url = pathToFileURL(target).href;

  assert.equal(isEntrypoint(url, target), true);
  assert.equal(isEntrypoint(url, undefined), false, "no argv[1] → not an entrypoint");
  assert.equal(isEntrypoint(url, join(dir, "other.mjs")), false, "missing path → false, not a throw");

  // macOS temp dirs are reachable via both /var and /private/var, and installed
  // scripts are commonly symlinked: comparison must be on canonical paths.
  const link = join(dir, "link.mjs");
  try {
    symlinkSync(target, link, "file");
    assert.equal(isEntrypoint(url, link), true, "symlink alias resolves to the same module");
  } catch (error) {
    if (!isWindows) throw error; // Windows without developer mode cannot symlink
  }
}

// --- normalizePaseoCwd / resolveCanonicalCwds --------------------------------
//
// Moved here from reconcile-observer.mjs when governance-graph became the
// second consumer of agent-scope identity. The reconciler's own suites are the
// zero-behaviour-change guard; these pin the contract for the new caller.

// `paseo ls --json` returns the tilde spelling and `paseo inspect --json`
// returns the absolute one FOR THE SAME DIRECTORY, on every run. Expansion is
// lexical: no filesystem access, so a path that does not exist still collapses.
assert.equal(normalizePaseoCwd("~"), homedir());
assert.equal(normalizePaseoCwd("~/proj"), join(homedir(), "proj"));
assert.equal(normalizePaseoCwd("~/proj/../proj"), join(homedir(), "proj"));
assert.equal(normalizePaseoCwd("/already/absolute"), "/already/absolute");
assert.equal(normalizePaseoCwd(""), "");
assert.equal(normalizePaseoCwd(undefined), "", "a missing cwd is empty, never the string 'undefined'");
assert.equal(normalizePaseoCwd("~notahome/x"), "~notahome/x", "only the ~ HOME form expands");

{
  const base = tmp("libcommon-canon-");
  const real = join(base, "repo");
  mkdirSync(real);
  const canonicalReal = realpathSync(real);
  const link = join(base, "alias");
  let linked = true;
  try {
    symlinkSync(real, link, "dir");
  } catch (error) {
    if (!isWindows) throw error; // Windows without developer mode cannot symlink
    linked = false;
  }

  const spellings = [real, `${real}/`, ...(linked ? [link] : [])];
  const map = await resolveCanonicalCwds([...spellings, join(base, "gone"), "", undefined]);

  for (const spelling of spellings) {
    assert.equal(map.get(spelling).canonical, canonicalReal, `${spelling} resolves to the one physical directory`);
    assert.equal(map.get(spelling).error, null);
  }
  assert.equal(
    new Set(spellings.map((s) => map.get(s).canonical)).size,
    1,
    "every spelling of one directory collapses to ONE identity — the whole point",
  );

  // A miss is recorded with its reason and NEVER falls back to the raw string:
  // callers must read null as "cannot verify", never as "not contained".
  assert.equal(map.get(join(base, "gone")).canonical, null);
  assert.match(map.get(join(base, "gone")).error, /ENOENT|no such file/i);
  assert.equal(map.has(""), false, "empty and non-string cwds are skipped, not resolved");
  assert.equal(map.has(undefined), false);

  // Memoized by raw string: one entry per distinct spelling, not per request.
  const repeated = await resolveCanonicalCwds([real, real, real]);
  assert.equal(repeated.size, 1);
}

// --- leadWriteEnabled --------------------------------------------------------
//
// KILLING TEST — parity with extensions/policy-core.mts, which is the module
// that actually grants the lead its tools. Two parsers for one env var had
// already drifted: governance-graph's truthy check read "0" and "false" as
// ENABLED, so its policy node reported the opposite of the running policy.
// policy-core's `leadWriteEnabled()` is private, so parity is measured through
// the exported `policyFor()` — the observable that matters. Importing a .mts
// module adds no platform requirement: `npm test` already runs test/*.test.mts.
{
  const { policyFor } = await import("../extensions/policy-core.mts");
  const previous = process.env.PASEO_TEAM_LEAD_WRITE;

  for (const raw of ["", "0", "false", "no", "off", "1", "true", "yes", "YES", " 1 ", "TRUE"]) {
    process.env.PASEO_TEAM_LEAD_WRITE = raw;
    const granted = policyFor("lead", "read-only").allow.includes("write");
    assert.equal(
      leadWriteEnabled(),
      granted,
      `PASEO_TEAM_LEAD_WRITE=${JSON.stringify(raw)}: the graph must report exactly what the hook grants`,
    );
  }
  // The specific inversion that shipped: a truthy check called these enabled.
  assert.equal(leadWriteEnabled({ PASEO_TEAM_LEAD_WRITE: "0" }), false);
  assert.equal(leadWriteEnabled({ PASEO_TEAM_LEAD_WRITE: "false" }), false);
  assert.equal(leadWriteEnabled({ PASEO_TEAM_LEAD_WRITE: "1" }), true);
  assert.equal(leadWriteEnabled({}), false, "unset is disabled");

  delete process.env.PASEO_TEAM_LEAD_WRITE;
  assert.equal(leadWriteEnabled(), false);
  if (previous === undefined) delete process.env.PASEO_TEAM_LEAD_WRITE;
  else process.env.PASEO_TEAM_LEAD_WRITE = previous;
}

// --- OCR version helpers -----------------------------------------------------

assert.equal(parseOcrVersion("open-code-review v1.8.10"), "1.8.10");
assert.equal(parseOcrVersion("open-code-review v1.9.2 (5b37b5f8e) windows/amd64"), "1.9.2");
assert.equal(parseOcrVersion("ocr unknown"), null);
assert.equal(parseOcrVersion(undefined), null, "non-string input is not a throw");

assert.equal(compareOcrVersions("1.8.10", "1.8.10"), 0);
assert.equal(compareOcrVersions("1.8.9", "1.8.10"), -1, "numeric compare, not lexicographic");
assert.equal(compareOcrVersions("1.10.0", "1.9.9"), 1);
assert.equal(compareOcrVersions("2", "1.9.9"), 1, "missing segments count as 0");

console.log("lib-common tests passed");
