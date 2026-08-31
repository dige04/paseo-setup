import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIONABLE_DISPOSITIONS,
  activityDigest,
  classifyWake,
  collectWakeEvidence,
  DEFAULT_MAX_ATTEMPTS,
  exitCodeFor,
  nextWakeState,
  parseWakeArgs,
  planWake,
  readWakeState,
  sendArgv,
  wakeAgents,
  WAKE_DISPOSITIONS,
  wakePrompt,
  writeWakeState,
} from "../scripts/wake-tier.mjs";

const CLI = fileURLToPath(new URL("../scripts/wake-tier.mjs", import.meta.url));
const HUNG = 10 * 60_000;

/** A corroborated hang: stale timestamp AND an activity tail that did not move. */
function hung(overrides = {}) {
  return {
    id: "hung-1",
    status: "running",
    inspectOk: true,
    ageMs: 30 * 60_000,
    pendingPermissions: [],
    activityA: "digest-aaaa",
    activityB: "digest-aaaa",
    wakeAttempts: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The ladder. Every rung is reachable, and precedence is asserted where two
// rungs could both match.
// ---------------------------------------------------------------------------

assert.deepEqual(WAKE_DISPOSITIONS, [
  "healthy",
  "blocked-on-permission",
  "wake-candidate",
  "escalate-to-human",
  "gone",
  "cannot-verify",
]);

assert.equal(classifyWake(hung()).disposition, "wake-candidate");
assert.equal(classifyWake(hung()).attempt, 1);
assert.equal(classifyWake(hung({ status: "idle" })).disposition, "gone");
assert.equal(classifyWake(hung({ inspectOk: false })).disposition, "cannot-verify");
assert.equal(classifyWake(hung({ ageMs: 60_000 })).disposition, "healthy");
assert.equal(classifyWake(hung({ ageMs: null })).disposition, "cannot-verify");

// A permission prompt outranks staleness. If this check ever moves below the
// staleness rung, a blocked agent starts collecting useless wakes instead of
// reaching the one thing that unblocks it: a human. That regression turns this
// assertion red, which is the whole reason it names the ordering explicitly.
{
  const blocked = classifyWake(hung({ pendingPermissions: [{ tool: "write" }] }));
  assert.equal(blocked.disposition, "blocked-on-permission");
  assert.match(blocked.reason, /human must answer/);
}

// One signal is never enough. Missing either probe keeps it unverified.
assert.equal(classifyWake(hung({ activityB: null })).disposition, "cannot-verify");
assert.equal(classifyWake(hung({ activityA: null })).disposition, "cannot-verify");
assert.match(classifyWake(hung({ activityB: null })).reason, /one signal never wakes/);

// Signal 2 disagreeing beats signal 1: a moving activity tail means the agent
// is working through a long call, and the stale timestamp is the weaker claim.
{
  const moving = classifyWake(hung({ activityB: "digest-bbbb" }));
  assert.equal(moving.disposition, "healthy");
  assert.match(moving.reason, /activity tail moved/);
}

// The ladder terminates: a third wake is never planned.
assert.equal(classifyWake(hung({ wakeAttempts: 1 })).disposition, "wake-candidate");
assert.equal(classifyWake(hung({ wakeAttempts: 1 })).attempt, 2);
assert.equal(classifyWake(hung({ wakeAttempts: 2 })).disposition, "escalate-to-human");
assert.equal(classifyWake(hung({ wakeAttempts: 9 })).disposition, "escalate-to-human");
assert.equal(DEFAULT_MAX_ATTEMPTS, 2);

// ---------------------------------------------------------------------------
// POSITIVE CONTROL (AP-02): prove a wake actually FIRES through the real
// wakeAgents path. `disposition === "wake-candidate"` alone would be a green
// gate nothing can prove alive — the exact shape of the M12 mutation that
// survived a whole review cycle.
// ---------------------------------------------------------------------------
{
  const plan = planWake([hung()], { now: 0 });
  assert.equal(plan.wake.length, 1);

  const sent = [];
  const result = await wakeAgents(plan, {
    sendPrompt: (id, prompt) => {
      sent.push({ id, prompt });
    },
  });
  assert.equal(sent.length, 1, "a corroborated hang must produce exactly one real send");
  assert.equal(sent[0].id, "hung-1");
  assert.match(sent[0].prompt, /\[wake-tier probe 1\/2\]/);
  // A wake must not read as a task: authority still comes from the V3 brief.
  assert.match(sent[0].prompt, /Do not start new work/);
  assert.deepEqual(result.woke, [{ id: "hung-1", attempt: 1 }]);
  assert.deepEqual(result.failed, []);
}

// The negative half of the same control: a blocked agent reaches sendPrompt
// zero times.
{
  const plan = planWake([hung({ pendingPermissions: [{ tool: "bash" }] })], { now: 0 });
  assert.equal(plan.wake.length, 0);
  const sent = [];
  await wakeAgents(plan, { sendPrompt: (id) => sent.push(id) });
  assert.deepEqual(sent, []);
}

// A send that throws is recorded, not swallowed, and never counted as a wake.
{
  const plan = planWake([hung()], { now: 0 });
  const result = await wakeAgents(plan, {
    sendPrompt: () => {
      throw new Error("daemon unreachable");
    },
  });
  assert.deepEqual(result.woke, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /daemon unreachable/);
}

// wakeAgents is authority-bound: an id the plan did not authorise is refused,
// so "the classifier approved this wake" stays checkable rather than assumed.
{
  const plan = planWake([hung()], { now: 0 });
  await assert.rejects(
    () => wakeAgents(plan, { sendPrompt: () => {}, only: [{ id: "not-in-plan", prompt: "x" }] }),
    (error) => error.code === "WAKE_FAILED" && /refusing to wake not-in-plan/.test(error.message),
  );
}

await assert.rejects(() => wakeAgents({ wake: [] }, {}), (error) => error.code === "USAGE");

// ---------------------------------------------------------------------------
// Planning: caps are stated, never silent.
// ---------------------------------------------------------------------------
{
  const five = Array.from({ length: 5 }, (_, i) => hung({ id: `h${i}` }));
  const plan = planWake(five, { maxWakes: 3, now: 0 });
  assert.equal(plan.wake.length, 3);
  assert.equal(plan.deferred.length, 2);
  assert.deepEqual(plan.deferred.map((entry) => entry.id), ["h3", "h4"]);
  assert.match(plan.deferred[0].reason, /over the per-run wake cap \(3\)/);
  assert.match(plan.deferred[0].reason, /not dropped/);
  assert.equal(plan.counts["wake-candidate"], 5);
  assert.equal(plan.actionable, true);
  assert.equal(exitCodeFor(plan), 3);
}

// P5 inversion: running agents exist but not one could be classified. That is
// a broken observer reporting a clean fleet, so it is actionable, not green.
{
  const blind = planWake([hung({ inspectOk: false }), hung({ id: "b2", inspectOk: false })], { now: 0 });
  assert.equal(blind.blind, true);
  assert.equal(blind.actionable, false, "cannot-verify is not itself actionable");
  assert.equal(exitCodeFor(blind), 3, "a blind scan must not exit 0");
}

// An empty fleet is genuinely empty — nothing running, nothing to report.
{
  const empty = planWake([], { now: 0 });
  assert.equal(empty.blind, false);
  assert.equal(exitCodeFor(empty), 0);
}

// A healthy fleet exits 0 and plans nothing.
{
  const plan = planWake([hung({ ageMs: 1000 }), hung({ id: "h2", ageMs: 2000 })], { now: 0 });
  assert.equal(plan.counts.healthy, 2);
  assert.equal(exitCodeFor(plan), 0);
  assert.equal(plan.wake.length, 0);
}

// Every actionable disposition really does drive exit 3, one at a time.
for (const [disposition, evidence] of [
  ["wake-candidate", hung()],
  ["escalate-to-human", hung({ wakeAttempts: 2 })],
  ["blocked-on-permission", hung({ pendingPermissions: [{}] })],
  ["gone", hung({ status: "closed" })],
]) {
  const plan = planWake([evidence], { now: 0 });
  assert.equal(plan.items[0].disposition, disposition);
  assert.ok(ACTIONABLE_DISPOSITIONS.includes(disposition));
  assert.equal(exitCodeFor(plan), 3, `${disposition} must exit 3`);
}

// ---------------------------------------------------------------------------
// State: the attempt counter that makes the ladder terminate.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "wake-state-"));
  const path = join(dir, "wake-tier.json");
  assert.deepEqual(readWakeState(path), { version: 1, agents: {} });

  const plan = planWake([hung(), hung({ id: "ok", ageMs: 1000 })], { now: 0 });
  const after = nextWakeState({ agents: { ok: { attempts: 1 } } }, plan, ["hung-1"], 1_000);
  assert.equal(after.agents["hung-1"].attempts, 1);
  assert.equal(after.agents["hung-1"].lastWakeAt, "1970-01-01T00:00:01.000Z");
  // Seen healthy → counter cleared. The ladder counts CONSECUTIVE unanswered
  // wakes; without this a single slow turn long ago would push a future hang
  // straight past the wake rung to escalation.
  assert.equal(after.agents.ok, undefined);

  writeWakeState(path, after);
  assert.equal(readWakeState(path).agents["hung-1"].attempts, 1);

  writeFileSync(path, "{ not json");
  assert.throws(() => readWakeState(path), (error) => error.code === "STATE_UNREADABLE");
  writeFileSync(path, JSON.stringify({ version: 1 }));
  assert.throws(() => readWakeState(path), (error) => error.code === "STATE_UNREADABLE");
}

// Two runs in sequence: wake, wake, then stop. Proves the ladder ends where it
// says it does rather than re-prompting a dead agent forever.
{
  let state = { version: 1, agents: {} };
  const dispositions = [];
  for (let run = 0; run < 3; run++) {
    const evidence = hung({ wakeAttempts: state.agents["hung-1"]?.attempts ?? 0 });
    const plan = planWake([evidence], { now: 0 });
    dispositions.push(plan.items[0].disposition);
    state = nextWakeState(state, plan, plan.wake.map((entry) => entry.id), run);
  }
  assert.deepEqual(dispositions, ["wake-candidate", "wake-candidate", "escalate-to-human"]);
}

// ---------------------------------------------------------------------------
// Evidence collection: probe twice, and only the shortlist.
// ---------------------------------------------------------------------------
{
  const snapshot = {
    agents: [
      { id: "stale", status: "running", inspectOk: true, ageMs: 20 * 60_000, pendingPermissions: [] },
      { id: "fresh", status: "running", inspectOk: true, ageMs: 1000, pendingPermissions: [] },
      { id: "blocked", status: "running", inspectOk: true, ageMs: 20 * 60_000, pendingPermissions: [{}] },
      { id: "dark", status: "running", inspectOk: false, ageMs: null, pendingPermissions: [] },
    ],
  };
  const reads = [];
  let slept = 0;
  const { evidences } = await collectWakeEvidence({
    snapshot,
    hungAfterMs: HUNG,
    probeGapMs: 1234,
    sleep: async (ms) => {
      slept = ms;
    },
    readActivity: async (id) => {
      reads.push(id);
      return `tail for ${id}`;
    },
  });
  // Only the one agent that reaches the corroboration rung is probed, and it
  // is probed twice. Probing a healthy fleet would buy a probeGapMs wait for
  // nothing; probing a blocked agent would corroborate the wrong question.
  assert.deepEqual(reads, ["stale", "stale"]);
  assert.equal(slept, 1234);
  const stale = evidences.find((entry) => entry.id === "stale");
  assert.equal(stale.activityA, activityDigest("tail for stale"));
  assert.equal(stale.activityA, stale.activityB);
  assert.equal(classifyWake(stale, { hungAfterMs: HUNG }).disposition, "wake-candidate");
  assert.equal(evidences.find((entry) => entry.id === "fresh").activityA, null);
}

// A probe that throws leaves the digest null, so the agent stays unverified.
{
  const snapshot = {
    agents: [{ id: "stale", status: "running", inspectOk: true, ageMs: 20 * 60_000, pendingPermissions: [] }],
  };
  const { evidences } = await collectWakeEvidence({
    snapshot,
    hungAfterMs: HUNG,
    probeGapMs: 0,
    sleep: async () => {},
    readActivity: async () => {
      throw new Error("logs unavailable");
    },
  });
  assert.equal(evidences[0].activityA, null);
  assert.equal(classifyWake(evidences[0], { hungAfterMs: HUNG }).disposition, "cannot-verify");
}

// No shortlist → no probing at all, and no wait.
{
  let slept = false;
  const { evidences } = await collectWakeEvidence({
    snapshot: { agents: [{ id: "fresh", status: "running", inspectOk: true, ageMs: 10, pendingPermissions: [] }] },
    hungAfterMs: HUNG,
    sleep: async () => {
      slept = true;
    },
    readActivity: async () => "never",
  });
  assert.equal(slept, false);
  assert.equal(evidences[0].activityA, null);
}

// Digest is content-addressed: an unchanged spinner is not progress.
assert.equal(activityDigest("  same  "), activityDigest("same"));
assert.notEqual(activityDigest("a"), activityDigest("b"));
assert.equal(activityDigest(null), null);

// ---------------------------------------------------------------------------
// Argument parsing and the CLI's real process boundary.
// ---------------------------------------------------------------------------

assert.deepEqual(parseWakeArgs([]), { wake: false });
assert.deepEqual(parseWakeArgs(["--wake"]), { wake: true });
assert.equal(parseWakeArgs(["--max-wakes", "5"]).maxWakes, 5);
assert.equal(parseWakeArgs(["--hung-after-ms", "60000"]).hungAfterMs, 60_000);
assert.throws(() => parseWakeArgs(["--nope"]), (error) => error.code === "USAGE");
assert.throws(() => parseWakeArgs(["--max-wakes"]), (error) => error.code === "USAGE");
assert.throws(() => parseWakeArgs(["--max-wakes", "abc"]), (error) => error.code === "USAGE");

// Reading is the default: no `--wake` flag means the CLI cannot mutate. That
// is asserted on the parsed shape because the alternative — an actuator that
// runs unless something disables it — is the failure this whole module avoids.
assert.equal(parseWakeArgs(["--max-wakes", "3"]).wake, false);

// Through the real process boundary: a usage error must be exit 2 with a
// structured envelope, and must never reach the daemon.
for (const argv of [["--nope"], ["--max-wakes"], ["--probe-gap-ms", "x"]]) {
  let failed = false;
  try {
    execFileSync(process.execPath, [CLI, ...argv], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    failed = true;
    assert.equal(error.status, 2, `${argv.join(" ")} must exit 2`);
    const envelope = JSON.parse(String(error.stderr).trim());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, "USAGE");
  }
  assert.ok(failed, `${argv.join(" ")} must fail`);
}

assert.match(wakePrompt({ attempt: 2, maxAttempts: 2, idleMinutes: 42 }), /probe 2\/2/);
assert.match(wakePrompt({ attempt: 1, maxAttempts: 2, idleMinutes: 42 }), /42m/);

// The mutating command form. Everything else about the actuator is proven with
// an injected spy, and a spy cannot tell you the argv is wrong — so the one
// real command this module can issue is pinned here.
assert.deepEqual(sendArgv("abc", "hello"), ["send", "abc", "--prompt", "hello", "--no-wait"]);
assert.ok(sendArgv("a", "b").includes("--no-wait"), "a wake must not block the scan on the reply");

// NEGATIVE CONTROL, symmetric to the positive one above: a scan writes nothing.
// The Supervisor is sanctioned to run the scan and is documented mutates:false,
// so a state write inside this process would be a mutation the hook cannot see —
// and because nextWakeState clears the counter of every healthy agent, a scan
// landing between the Lead's two wakes would reset a ladder mid-escalation.
{
  const dir = mkdtempSync(join(tmpdir(), "wake-readonly-"));
  const statePath = join(dir, "state", "wake-tier.json");
  const run = (argv) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [CLI, ...argv], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, PASEO_TEAM_STATE_DIR: join(dir, "state"), PASEO_TEAM_PASEO_EXEC: "" },
      }) };
    } catch (error) {
      return { status: error.status, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
    }
  };
  // No daemon is reachable here, so the scan fails on collection — which is
  // exactly the run that must not leave a state file behind either.
  run([]);
  assert.ok(!existsSync(statePath), "a scan must not create the wake state file");

  // And with a state file already present, a scan must leave it byte-identical.
  mkdirSync(join(dir, "state"), { recursive: true });
  const before = JSON.stringify({ version: 1, agents: { keep: { attempts: 1, lastWakeAt: "1970-01-01T00:00:00.000Z" } } }, null, 2) + "\n";
  writeFileSync(statePath, before);
  run(["--hung-after-ms", "60000"]);
  assert.equal(readFileSync(statePath, "utf8"), before, "a scan must not rewrite the wake state file");
}

console.log("wake-tier: ok");
