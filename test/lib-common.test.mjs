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
  HARNESS_DISPOSITION_VALUES,
  HARNESS_ROLE_VALUES,
  HARNESS_SCHEMA_VERSION,
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
  validateLabelSelector,
} from "../scripts/lib-common.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// --- label selector guard ----------------------------------------------------
//
// KILLING TEST — the key-only FAIL-OPEN, measured on Paseo 0.6.1: `paseo ls
// --label harness.role` (key, no value) returned the ENTIRE 200-agent fleet
// instead of erroring or returning nothing. Any sweep that computes "who is in
// no role set" from that answer concludes that everybody is labelled, and the
// residue clause it feeds goes silently vacuous — a fail-open at the daemon
// turning into a fail-open in the audit. The daemon offers no existence or
// negation selector to cross-check against, so this validator is the only
// thing that stops it, and it must THROW rather than sanitize: a repaired
// selector would query for something the caller did not ask for.
{
  assert.equal(validateLabelSelector("harness.role=peer"), "harness.role=peer");
  assert.equal(validateLabelSelector("harness.owner=paseo-claude-team"), "harness.owner=paseo-claude-team");
  assert.equal(validateLabelSelector("k=v with spaces"), "k=v with spaces", "values are free text");

  for (const bad of [
    "harness.role",            // THE measured fail-open: key, no value
    "harness.role=",           // empty value
    "=peer",                   // no key
    "harness role=peer",       // space in key
    "harness.role=a=b",        // a second separator selects something else
    "harness.role=peer\n--label", // newline smuggling a second selector
    "",
    undefined,
    null,
    42,
    ["harness.role=peer"],
    `k=${"v".repeat(300)}`,    // length ceiling
  ]) {
    assert.throws(() => validateLabelSelector(bad), /invalid label selector/,
      `must throw: ${JSON.stringify(bad)}`);
  }
}

// The validator is behaviour-identical to the private copy in
// reconcile-observer.mjs, which is the pattern it inherits. That file was out
// of scope to edit when this moved here, so the two are pinned against each
// other through the reconciler's own public option validator rather than left
// to drift into two different ideas of a valid selector.
{
  const { normalizeReconcileOptions } = await import("../scripts/reconcile-observer.mjs");
  const accepts = (label) => {
    try { normalizeReconcileOptions({ managedLabels: [label] }); return true; } catch { return false; }
  };
  for (const label of ["harness.owner=paseo-claude-team", "k=v with spaces", "harness.role", "=peer", "harness.role=a=b", ""]) {
    let mine = true;
    try { validateLabelSelector(label); } catch { mine = false; }
    assert.equal(mine, accepts(label), `selector verdicts must agree on ${JSON.stringify(label)}`);
  }
}

// --- closed label vocabularies -----------------------------------------------
//
// KILLING TEST — ONE VOCABULARY OWNER (F015). extensions/policy-core.mts owns
// both closed sets; this module holds the only runtime mirror, because the
// installer puts policy-core.mts at $CLAUDE_TEAM_DIR/ and support scripts at
// $CLAUDE_TEAM_DIR/scripts/, so no relative specifier reaches it from a .mjs
// consumer in both the repo and the installed layout.
//
// The defect this closes is not hypothetical: remote-paseo.mjs and
// policy-core.mts each kept their own literal Set of
// {observer,writer,reviewer,lead,supervisor} while the fleet ran on
// {peer,scout,architect}, so the reconciler and the graph keyed on different
// words and NEITHER COULD DETECT THE OTHER LYING. Parity plus the no-third-copy
// scan below is what keeps that from re-forming.
{
  const core = await import("../extensions/policy-core.mts");
  assert.deepEqual([...HARNESS_ROLE_VALUES], [...core.HARNESS_ROLE_VALUES]);
  assert.deepEqual([...HARNESS_DISPOSITION_VALUES], [...core.HARNESS_DISPOSITION_VALUES]);
  assert.equal(HARNESS_SCHEMA_VERSION, core.HARNESS_SCHEMA_VERSION);
  // Layer 1 is exactly TeamRole — the axis the provider config projects.
  assert.deepEqual([...HARNESS_ROLE_VALUES].sort(), ["lead", "peer", "supervisor"]);
  // Layer 2 is exactly the V3 brief DISPOSITION vocabulary.
  const { WORKSPACE_DISPOSITIONS } = await import("../scripts/remote-paseo.mjs");
  assert.deepEqual([...WORKSPACE_DISPOSITIONS], [...HARNESS_DISPOSITION_VALUES]);
  assert.ok(Object.isFrozen(HARNESS_ROLE_VALUES) && Object.isFrozen(HARNESS_DISPOSITION_VALUES));
}

// NO SECOND LITERAL COPY. Owner and mirror are the only two files allowed to
// spell either vocabulary out; everyone else imports. A third literal is how
// the last split started, and it starts as a one-line convenience every time.
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const OWNERS = new Set(["extensions/policy-core.mts", "scripts/lib-common.mjs"]);
  // The full literal, in either declaration order, with any quoting/whitespace.
  const roleLiteral = /["'`]lead["'`]\s*,\s*["'`]peer["'`]|["'`]peer["'`][^;]{0,80}["'`]supervisor["'`]|["'`]supervisor["'`]\s*,\s*["'`]lead["'`]/;
  const dispositionLiteral = /["'`]repository-scout["'`]/;
  const files = [
    ...["policy-core.mts", "claude-policy.mts"].map((f) => `extensions/${f}`),
    ...["lib-common.mjs", "governance-graph.mjs", "remote-paseo.mjs", "reconcile-observer.mjs", "watchdog.mjs", "model-routing.mjs"]
      .map((f) => `scripts/${f}`),
  ];
  // The scanned list is hand-maintained, so a rename would silently drop a file
  // from coverage while the scan stayed green — the same silent-gap defect the
  // scan exists to prevent, one level up.
  for (const relative of [...files, ...OWNERS]) {
    assert.ok(existsSync(join(root, relative)), `${relative} is scanned for vocabulary copies but does not exist`);
  }
  for (const relative of files) {
    if (OWNERS.has(relative)) continue;
    const body = readFileSync(join(root, relative), "utf8");
    assert.ok(!dispositionLiteral.test(body),
      `${relative} spells the disposition vocabulary out; import HARNESS_DISPOSITION_VALUES instead`);
    assert.ok(!roleLiteral.test(body),
      `${relative} spells the role vocabulary out; import HARNESS_ROLE_VALUES instead`);
  }

  // THE ONE KNOWN EXCEPTION, pinned rather than banned. extensions/
  // claude-team-hook.mjs keeps a private `ROLES` Set for PASEO_CLAUDE_ROLE
  // validation. It already imports ./policy-core.mts at runtime, so deleting
  // the copy is a one-line change — it was simply outside the scope that
  // landed F015. Until then this asserts the copy is the SAME vocabulary, so
  // the split cannot silently re-open while the file waits its turn.
  const hook = readFileSync(join(root, "extensions", "claude-team-hook.mjs"), "utf8");
  const declared = hook.match(/const ROLES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(declared, "claude-team-hook.mjs must still declare ROLES in the pinned shape");
  assert.deepEqual(
    declared[1].split(",").map((token) => token.trim().replace(/^["'`]|["'`]$/g, "")).filter(Boolean).sort(),
    [...HARNESS_ROLE_VALUES].sort(),
    "claude-team-hook.mjs ROLES has drifted from the owner; import HARNESS_ROLE_VALUES from ./policy-core.mts",
  );
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
