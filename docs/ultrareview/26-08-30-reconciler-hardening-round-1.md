# Ultra Review — reconciler-hardening — round 1

- **Date** 2026-08-30
- **Review name** reconciler-hardening
- **Round** 1
- **Scope** Uncommitted reconciler + session hardening vs base `4756b56`: observe-only daily
  reconciler (`reconcile-core.mjs`, `reconcile-observer.mjs`), lsof probe rewrite, fail-closed
  inventory guards, standalone-clone detection, `update_agent` label immutability, per-role
  Skill admission, preflight flag rejection, policy digest + manifest.
- **Report path** `docs/ultrareview/26-08-30-reconciler-hardening-round-1.md`
- **Review brief SHA256** `acca4656df2b6cf4589311cf4e17914c83599b5616ac4c8c76768794f8555cba`

## Scout Roster

| Scout | Provider / model | Concerns | Result |
|---|---|---|---|
| scout-01 | omp/google-antigravity/gemini-3.7-flash | G01, G02 | SUBMITTED (5) |
| scout-02 | omp/google-antigravity/gemini-3.7-flash | G02, G03 | PARTIAL (live disconfirming checks; cancelled mid-loop after converging on already-found F004/F026) |
| scout-03 | omp/google-antigravity/gemini-3.7-flash | G03, G04 | SUBMITTED (9) |
| scout-04 | omp/google-antigravity/gemini-3.7-flash | G04, G05 | SUBMITTED (7) |
| scout-05 | omp/google-antigravity/gemini-3.7-flash | G05, G06 | SUBMITTED (8) |
| scout-06 | omp/google-antigravity/gemini-3.7-flash | G06, G07 | SUBMITTED (10) |
| scout-07 | omp/google-antigravity/gemini-3.7-flash | G07, G08 | SUBMITTED (8) |
| scout-08 | omp/google-antigravity/gemini-3.7-flash | G01, G07, G08 | SUBMITTED (9) |
| scout-09 | omp/google-antigravity/gemini-3.7-flash | G01, G04, G06 | SUBMITTED (11) |
| scout-10 | **claude-peer/claude-sonnet-5** (calibration probe) | G02, G03, G05, G08 | SUBMITTED (7) |

`SCOUTS_PLANNED: 10` · `SCOUTS_SUBMITTED: 9 full + 1 partial` · `SCOUTS_MISSING: 0`

Routing note: nine scouts on `omp/google-antigravity/gemini-3.7-flash` (the tier under test),
one `claude-peer` calibration probe to measure whether a different provider family surfaces a
different class of defect. It did — see the calibration note below. Read-only enforced by the
`omp` `write`→`full` mode plus the V3 brief's `MODE: read-only`; every scout's shell was
Lead-approved per turn (all requests were `git status/diff/show` and read-only `node -e`
disconfirming checks; zero mutating commands were requested).

## Consolidated Findings

Ordered by severity then cross-validation strength. `[Nx]` = number of independent scouts that
reached this root cause. Findings the Lead reproduced live are marked **[VERIFIED live]**.

### F001 · P1 · confidence high · [7 scouts] — `isPathInside` returns true across Windows drive letters
`scripts/reconcile-core.mjs:8-13`. On Windows, `path.win32.relative("C:\\wt", "D:\\other")`
returns the absolute `"D:\\other"`, which does not start with `..` or `sep`, so `isPathInside`
returns `true`. Corrupts `canonicalOwnership` (foreign D: checkout → `paseoOwned:true`),
`agentsUnder`, `terminalsUnder`, `isCwdInUse`.
Reported by scout-01, 03, 05, 06, 07, 08, 09 — the strongest cross-validation in the round.
**Contract:** lexical containment must fail closed across volumes.
**Fix:** add `!isAbsolute(rel)` to the guard.
**Disconfirming check:** `isPathInside("C:\\wt","D:\\other")` under `path.win32` → currently `true`.

### F002 · P1 · confidence high · [4 scouts] — `classifyAgentHealth` throws on null/non-object agent
`scripts/reconcile-core.mjs:42-45`. A `managedAgents` array containing `null`/a primitive makes
`classifyWorkspaceRetirement`/`classifyOrphanWorktree` throw `TypeError` instead of refusing
fail-closed — the whole reconcile pass crashes rather than returning `cannot_verify`.
Reported by scout-01, 03, 08, 09.
**Fix:** guard object shape at entry → `cannot_verify` + `agent_record_malformed` (unknown).
**Disconfirming check:** `classifyAgentHealth(null)` → throws.

### F003 · P2 · confidence high · [4 scouts] — preflight VALUE_FLAG swallows the next flag (the `--stict` hole is still reachable)
`scripts/preflight.mjs:58-71`. The unknown-flag scan does `if (VALUE_FLAGS.has(token)) { i += 1; continue; }`
with no check that the consumed value isn't itself a flag. `--routes --stict` consumes `--stict`
as the routes value, so the exact typo the fix exists to catch runs non-strict again. A trailing
value flag (`--cluster` with no value) also silently falls back to default.
Reported by scout-04, 06, 07, 08.
**Fix:** require `argv[i+1]` to exist and not start with `-`; else `missing_flag_value` exit 2.

### F004 · P2 · confidence high · [4 scouts] — `normalizePaseoCwd` not applied to workspace/terminal cwd
`scripts/reconcile-observer.mjs:~257,~455`. `compactAgent` normalizes tilde cwds; the workspace
and terminal mappings do not. If the daemon ever reports a workspace/terminal `cwd` as
`~/.paseo/...`, correlation against normalized agent cwds silently fails (empty managed history,
missed `agent_active`/`terminal_active`, active workspace walked as an orphan).
**[VERIFIED live — not currently triggering]:** in the Lead's E2E, `paseo workspace ls` returned
absolute paths, so this is latent today, not active. It is fragile-by-construction: two sources
of the same path, only one normalized.
Reported by scout-03, 07, 08 (+ scout-10 via the realpath variant).
**Fix:** wrap both mappings in `normalizePaseoCwd`.

### F005 · P2 · confidence high · [4 scouts] — `config/skill-admission.json` is outside the policy digest
`scripts/policy-digest.mjs:24-27`. `GOVERNED`/`GOVERNED_FILES` omit `config/`. The admission map
is a governing policy input (parity-tested against `policy-core.mts`) yet edits to it do not move
`policyDigest`, so `--check` reports fresh on drifted admission rules.
Reported by scout-05, 06, 07, 08.
**Fix:** add `config/skill-admission.json` to `GOVERNED_FILES`.

### F006 · P2 · confidence high · [4 scouts] — installers omit `repo-refresh` skill and `policy-digest.mjs`
`scripts/install.sh:73`, `scripts/install.ps1:52`, `TEAM_SUPPORT_FILES`. `repo-refresh` is in
`PACK_SKILLS` and `config/skill-admission.json` but neither installer copies it; `policy-digest.mjs`
is not in the support-file list, so an installed host cannot run `--check`.
Reported by scout-03, 06, 07, 08.
**Fix:** add `repo-refresh` to both skill loops and `policy-digest.mjs` to `TEAM_SUPPORT_FILES`;
update `test/installer-contract.test.mjs`.

### F007 · P2 · confidence high · [3 scouts] — `classifyOrphanWorktree` bypasses `inventoryBlockers` for `managedAgents`
`scripts/reconcile-core.mjs:180`. The workspace path uses `inventoryBlockers("managed_agents", …)`;
the orphan path kept the old `!Array.isArray` check, so a malformed `managedAgents` on an orphan
reads as `no_managed_agent_history` instead of `managed_agents_inventory_malformed`. The malformed
test matrix omits `managedAgents`, so the gap is uncovered.
Reported by scout-04, 05, 06.
**Fix:** use `inventoryBlockers` in the orphan path too; add `["managedAgents", {}]` to the matrix.

### F008 · P2 · confidence high · [3 scouts] — `PASEO_TEAM_EXTRA_TOOLS` short-circuits every gate
`extensions/claude-policy.mts` — `if (extra.has(toolName)) return null;` sits above the subagent
ban, Paseo-tool gate, Skill admission, and write/shell guards. Setting the env var to a builtin
name (`Agent`, `Write`, `mcp__paseo__update_agent`, `Skill`) disables that protection. Pre-existing
(not a regression from this change) but now co-located with the new Skill/label gates it can void.
Reported by scout-03, 04, 09.
**Fix:** scope the bypass to `parseMcpToolName(toolName)` where `server !== "paseo"` and not a
builtin; or evaluate `extraTools` only in the third-party MCP branch.

### F009 · P2 · confidence high · [3 scouts, my new code] — `skillBlockReason` path-prefix / case bypass
`extensions/policy-core.mts:~748`. `name = skillName.trim().replace(/^\//,"")` then exact
`PACK_SKILLS.includes(name)`. `skills/paseo-team-lead`, `skill://…`, `paseo-team-lead/SKILL.md`,
or `PASEO-TEAM-LEAD` all miss the set and fall through to allow. Not reachable through Claude's
real Skill tool (exact-name contract) but defense-in-depth is the point of the gate.
Reported by scout-03, 04, 09.
**Fix:** normalize (strip `skill://`, leading `./`/`skills/`, trailing `/SKILL(.md)?`, lowercase)
before the membership test.

### F010 · P2 · confidence high · [3 scouts, my new code] — `policy-digest` is-main guard not realpath-symmetric
`scripts/policy-digest.mjs:117-121`. `realpathSync(process.argv[1])` is compared to a raw
`fileURLToPath(import.meta.url)`. Under `--preserve-symlinks` or symlinked module resolution the
two diverge, `main()` is skipped, and `--check` exits 0 silently on a stale manifest.
Reported by scout-06, 07, 08.
**Fix:** use `isEntrypoint(import.meta.url)` from `lib-common.mjs` (realpaths both sides).

### F011 · P2 · confidence high · [3 scouts] — `branchCandidates` not deduped → duplicate actions + unstable planDigest
`scripts/reconcile-core.mjs:~204`. Multiple candidate worktrees on the same branch emit duplicate
`review_local_branch_retirement` actions; `localeCompare` ties leave order input-dependent, so
`planDigest` is non-deterministic across runs.
Reported by scout-05, 06, 09.
**Fix:** dedupe by branch; add a `cwd`/`workspaceId` tiebreaker.

### F012 · P2 · confidence high · [2 scouts, incl. claude] — failed `remoteRefs` probe reads as confirmed `keep`
`scripts/reconcile-observer.mjs:~155` + `reconcile-core.mjs:63`. A failing `git branch -r --contains HEAD`
(timeout/error) maps `remoteRefs` to `[]`, identical to a real zero-remote result, so
`head_not_reachable_from_remote` is raised at **confirmed** certainty → `keep` instead of
`cannot_verify`. A human trusting "keep" as settled is misled.
Reported by scout-09, 10.
**Fix:** track probe success; emit `remote_refs_unknown` (unknown) on failure.

### F013 · P2 · confidence high · [1 scout, claude] — `rawOptions` spread after validated options defeats the timeout clamp
`scripts/reconcile-observer.mjs:~468,505`. `inspectProcessUse(cwd, { ...options, ...rawOptions })`
spreads the unvalidated `rawOptions` last, so an out-of-range `rawOptions.commandTimeoutMs` (0,
negative, huge) overrides `normalizeReconcileOptions`'s clamp for exactly the subprocess-timeout
consumers. `0` disables the git/lsof timeout (can hang the daily run); negative can throw inside
the un-try/caught `runFile` executor and crash the pass.
**Fix:** spread `rawOptions` first (or don't spread it into probe calls); pass only validated `options`.

### F014 · P2 · confidence high · [1 scout, claude] — the AP-02 qualification test is self-confirming on path spelling
`test/reconcile-qualification.test.mjs`. The one end-to-end positive control uses the identical
`wt` variable for both the workspace `cwd` and the agent `cwd` — never tilde, symlink, or case
variant. It is the only test exercising `agentsUnder`/`terminalsUnder`/`canonicalOwnership`
end-to-end (grep: zero unit coverage of those). So F001/F004 could regress with the suite green.
**Fix:** add a divergent-spelling case (agent cwd realpath'd, workspace cwd tilde/symlinked).

### F015 · P2 · confidence medium · [2 scouts] — `ageBlocker` with NaN `retireAfterMs` skips the grace veto
`scripts/reconcile-core.mjs:24-30`. `Math.max(60000, NaN) === NaN`; `ageMs < NaN === false`, so a
1-second-old workspace gets no `grace_period_active`. Unreachable through the public CLI
(`normalizeReconcileOptions` rejects non-finite) but the exported classifiers are called directly
in tests and by any other consumer.
**Fix:** `if (!Number.isFinite(ageMs) || !Number.isFinite(retireAfterMs)) return age_unknown`.

### F016 · P2 · confidence high · [2 scouts] — local `lifecycleLabelsBlockReason` lacks `paseo.*` + charset parity with remote
`extensions/policy-core.mts:701-725` vs `scripts/remote-paseo.mjs:~255`. Remote rejects reserved
`paseo.*` keys and enforces key/value charset+length; local create only checks the six required
`harness.*` keys, so a local `create_agent` can inject `paseo.*` or malformed values a remote run
would refuse.
**Fix:** mirror the `paseo.*` rejection and charset bounds in `lifecycleLabelsBlockReason`.

### F017 · P2 · confidence high · [2 scouts, my new code] — `update_agent` label gate misses prototype / non-normalized keys
`extensions/policy-core.mts:~800`. `Object.keys(labels).filter(k => k.startsWith("harness."))`
misses `{"__proto__": {...}}` (Object.keys → `[]`), and case/whitespace variants
(`"HARNESS.retention"`, `" harness.retention"`) if the daemon normalizes keys server-side.
Reported by scout-04, 09.
**Fix:** `Reflect.ownKeys` / reject non-`Object.prototype` prototypes; normalize keys
(`trim().toLowerCase()`, NFKC) before the `startsWith` test.

### F018 · P2 · confidence high · [1 scout] — preflight.mjs has no is-main guard (executes on import)
`scripts/preflight.mjs`. Unlike every sibling script it lacks an `isEntrypoint` guard, so any
`import` runs the whole CLI (arg parse, probes, `process.exit`). Blocks unit-testing preflight
helpers; only syntax-compile coverage exists.
**Fix:** wrap CLI execution in `if (isMainModule()) { … }`.

### F019 · P2 · confidence medium · [2 scouts] — report integrity: uninspected agents and orphan-scan `ok`
- `reconcile-observer.mjs:~501` (scout-05): an agent whose inspect failed lands in both
  `agents.active` and `agents.cannotVerify`, and `agent_not_archived` is raised at **confirmed**
  certainty despite `inspectOk:false`. **Fix:** set `archived:null` when `!inspectOk`; gate the blocker.
- `reconcile-observer.mjs:~454` (scout-05): orphan scan sets `sources.orphanScan.ok:true` even when
  `sources.terminals.ok` is false. **Fix:** include `terminals.ok` in the prerequisite.

### F020 · P3 · confidence high · [3 scouts] — `summary.candidates` excludes branch candidates
`scripts/reconcile-core.mjs:~236`. `summary` counts only workspaces+orphans; `proposedActions`
includes branches, so a consumer reading `summary.candidates` undercounts the action plan.
**Fix:** add explicit `workspaces`/`orphanWorktrees`/`branches`/`proposedActions` breakdown.

### F021 · P3 · confidence high · [1 scout, claude] — `isCwdInUse` is exported but test-only (AP-03)
`scripts/reconcile-core.mjs:16-18`. Zero production call sites; the observer reimplements the logic
inline (without the same realpath discipline). A tested "public contract" that isn't load-bearing —
exactly `docs/anti-patterns.md` AP-03.
**Fix:** either route the observer through it or drop the export and its test.

### F022 · P3 · confidence high · [1 scout] — preflight `PINNED.paseo` stale at `0.4.0`
`scripts/preflight.mjs:~43`. `SUPPORTED_PASEO_VERSION` and README are `0.6.1`; `PINNED.paseo` is
`0.4.0`, so preflight warns against a stale baseline. Pre-existing. **Fix:** bump to `0.6.1`.

### F023 · P3 · confidence medium · [many scouts] — orphan rotation advances 1/day, not by window size
`scripts/reconcile-observer.mjs:~355`. `cursor = |dayIndex| % out.length` shifts by one orphan per
day, re-inspecting `maxOrphans−1` duplicates daily and taking ~`out.length` days to cover a large
set; churn can perpetually defer a tail orphan.
**Fix:** stride by `maxOrphans` (`(dayIndex * maxOrphans) % out.length`).

### F024 · P3 · confidence medium · [2 scouts] — `inspectGitWorktree` uses `resolve`, not `realpath`, for the top-level check
`scripts/reconcile-observer.mjs:~134`. On symlinked homes/temp, `git rev-parse --show-toplevel`
(canonical) ≠ `resolve(cwd)` (literal) → false `git_unknown`. Latent under `~/.paseo` today; the
qualification test had to `realpath` in setup to avoid it (see F014).
**Fix:** `realpath` both sides before comparison.

### F025 · P3 · confidence high · [1 scout] — `parseTaskBrief` drops a V3 brief when a preamble precedes the marker
`extensions/policy-core.mts:~440`. `firstNonEmpty === V3_BEGIN` fails if a `<system-reminder>`
block precedes the marker → treated as unbriefed. Fail-**closed** (denies authority, safe) but an
availability false-negative. Pre-existing. **Fix:** locate the marker line rather than requiring it first.

## Verification Queue

Each read-only, safe to run:

- **F001** `node -e 'import("./scripts/reconcile-core.mjs").then(m=>console.log(m.isPathInside("C:\\a","D:\\b")))'` under win32 semantics.
- **F002** `classifyAgentHealth(null)` → expect throw (current) / `cannot_verify` (fixed).
- **F003** `node scripts/preflight.mjs --routes --stict; echo $?` → expect 2 (fixed), currently consumes `--stict`.
- **F004** feed a workspace with tilde `cwd` to `collectDailyReconciliation`; check `canonicalOwnership` ENOENT.
- **F005** edit `config/skill-admission.json`, re-run `policyDigest()`; digest must change.
- **F006** grep both installers for `repo-refresh` and `policy-digest.mjs`.
- **F007** `classifyOrphanWorktree({…, managedAgents:{}})` → expect `managed_agents_inventory_malformed`.
- **F008** `claudeToolBlockReason({role:"peer",toolName:"Write",…,extraTools:["Write"]})` → currently `null`.
- **F009** `skillBlockReason("peer","skills/paseo-team-lead",null)` → currently `null`.
- **F010** run `policy-digest.mjs --check` via a symlinked path with a stale manifest → currently exit 0.
- **F011** two candidate worktrees, same branch → `report.branches.candidates.length === 2`.
- **F012** inject a `runGit` that fails only `branch -r --contains` → observe confirmed `keep`.
- **F013** `collectDailyReconciliation({commandTimeoutMs:0})` → probe timeout disabled.
- **F017** `updateAgentLabelsBlockReason({labels:JSON.parse('{"__proto__":{"harness.retention":"ephemeral"}}')})` → currently `null`.

## Strongest Reason Not To Merge Yet

**F002** (crash-on-malformed-inventory) and **F001** (cross-drive containment) are the two that
break the reconciler's own stated contract — "fail closed, never throw, never mis-own." Both are
one-line fixes with clear disconfirming checks. Neither is triggered by the current test suite,
and **F014** explains why: the only end-to-end test can't produce the inputs that expose them.
Fix F001, F002, F007, F014 before this is called done; the rest are P2/P3 hardening that can land
incrementally.

## Calibration note — did provider diversity pay off?

Yes, measurably. The nine `gemini-3.7-flash` scouts converged hard on the mechanical/structural
class (F001 found by 7, F006/F005/F003 by 4 each) — high recall, strong cross-validation, exactly
what overlap is for. The single `claude-peer` probe (scout-10) was the *sole* source of three
findings the gemini fleet missed entirely: **F013** (rawOptions defeats the timeout clamp),
**F014** (the qualification fixture is self-confirming), **F021** (`isCwdInUse` is test-only /
AP-03) — all proof-debt / second-order reasoning rather than pattern-matched code smells. This is
the `paseo-ultra-review` skill's "model diversity is worth more here than anywhere else" claim,
confirmed on live data: the cheap fleet maximizes recall on the mechanical surface; one
independent-family probe catches the class the fleet is blind to.

## Applied fixes (Lead, same session)

The Lead reproduced the contract-breakers live and fixed them, with a regression test per fix
(suite 32→35 tests, all green; typecheck clean; manifest refreshed). Twelve of the ~27 distinct
root-cause findings were fixed this round; the rest are tracked P2/P3 below.

| Finding | Fix | Live re-verify |
|---|---|---|
| F001 | `isAbsolute(rel)` guard in `isPathInside` | disjoint roots → `false` |
| F002 | `classifyAgentHealth` object-shape guard → `cannot_verify` | `managedAgents:[null]` → `cannot_verify` (was: throw) |
| F003 | preflight rejects a value-flag whose value is missing or flag-like | `--routes --stict` → `missing_flag_value` exit 2 |
| F005 | `config/skill-admission.json` added to the policy digest | present in `--version` file set |
| F007 | orphan path uses `inventoryBlockers` | `managedAgents:{}` → `managed_agents_inventory_malformed` |
| F009 | `skillBlockReason` normalizes path/scheme/case before membership | `skills/paseo-team-lead` (peer) → denied |
| F010 | is-main guard realpaths both sides | symlinked stale-manifest `--check` → exit 1 |
| F011 | `branchCandidates` deduped by branch, stable tiebreak | two worktrees, one branch → 1 action |
| F013 | probe/git calls spread validated `options` last | clamp no longer overridden by `rawOptions` |
| F015 | `ageBlocker` rejects non-finite `retireAfterMs` | `retireAfterMs:NaN` → `age_unknown`, not candidate |
| F017 | `update_agent` gate rejects non-string label values + odd prototypes | `{"__proto__":{…}}` → refused |

> **F017 note for round 2:** the fix is on a *different mechanism* than the scouts reported. Their
> claim was that `Object.keys` misses a `__proto__` key. In fact `JSON.parse('{"__proto__":{…}}')`
> creates an own `__proto__` key whose **value is an object**, and the nested `harness.retention`
> never becomes a real top-level label — so the stated bypass does not mutate anything. The actual
> contract violation is that labels are a string→string map and the gate did not enforce value
> types; rejecting non-string values closes both the theoretical proto payload and real malformed
> input. A round-2 scout may legitimately re-derive the original `Object.keys` claim; it is answered
> here.
| F006 | installers ship `repo-refresh` + `policy-digest.mjs`; contract test updated | installer-contract test green |

**Root-fixed in the L3 cycle (T-L3-ARCH → T-L3-ENG → T-L3-REV, 2026-08-31):** F004, F014,
F024, S10-C1/C2, F021 — an architect-Peer ruled MIXED (F001 independent/keep; the rest ONE root:
no ingest-time canonicalization owner, plus three sites no scout cited), an engineer-Peer
implemented canonicalization-at-ingest under an outcome brief, and an independent reviewer-Peer
issued CHANGES_REQUIRED (3 mutation sites uncovered, one fail-open) → correction round → PASS.
Suite 36/36. This replaced what would have been four more symptom patches (AP-04).

**Not yet fixed (tracked P2/P3):** F008 (extraTools bypass — pre-existing surface), F012, F016,
F018–F020, F022, F023, F025 — none are contract-breakers.

## Next Receive Prompt

Round 2: add the F014 divergent-spelling case to `reconcile-qualification.test.mjs`, then harden
F004 (normalize workspace/terminal cwd), F008 (scope `PASEO_TEAM_EXTRA_TOOLS`), F012 (remote-ref
probe failure → unknown). Re-run `reconciler-hardening` with prior-round warnings seeded — do not
filter the fixed findings; a round-2 scout may legitimately revive one.
