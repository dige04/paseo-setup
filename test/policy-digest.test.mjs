import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { policyDigest } from "../scripts/policy-digest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("policy digest is deterministic and covers the governing dirs", () => {
  const a = policyDigest(root);
  const b = policyDigest(root);
  assert.equal(a.policyDigest, b.policyDigest);
  assert.match(a.policyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Object.keys(a.files).some((f) => f.startsWith("prompts/")));
  assert.ok(Object.keys(a.files).some((f) => f.startsWith("extensions/")));
  assert.ok(Object.keys(a.files).some((f) => f.startsWith("skills/")));
});

test("a one-byte edit to any governed file changes the digest", () => {
  const scratch = mkdtempSync(join(tmpdir(), "digest-gate-"));
  try {
    for (const dir of ["prompts", "extensions", "skills", "templates", "scripts"]) {
      cpSync(join(root, dir), join(scratch, dir), { recursive: true });
    }
    cpSync(join(root, "package.json"), join(scratch, "package.json"));
    const before = policyDigest(scratch).policyDigest;
    appendFileSync(join(scratch, "prompts", "lead.md"), " ");
    const after = policyDigest(scratch).policyDigest;
    assert.notEqual(before, after, "drift must be visible");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("ci.yml is a governed byte — weakening the CI gates must trip the digest", () => {
  // Bench cycle 1 finding: ci.yml carried the only pre-merge gates while
  // sitting OUTSIDE the digest perimeter, so a gate-weakening edit stayed
  // invisible to --check. Now it is a governed file like any other.
  assert.ok(
    Object.keys(policyDigest(root).files).includes(".github/workflows/ci.yml"),
    "the manifest must govern .github/workflows/ci.yml",
  );
  const scratch = mkdtempSync(join(tmpdir(), "digest-ci-"));
  try {
    for (const dir of ["prompts", "extensions", "skills", "templates", "scripts", ".github"]) {
      cpSync(join(root, dir), join(scratch, dir), { recursive: true });
    }
    cpSync(join(root, "package.json"), join(scratch, "package.json"));
    const before = policyDigest(scratch).policyDigest;
    appendFileSync(join(scratch, ".github", "workflows", "ci.yml"), "\n# drift\n");
    const after = policyDigest(scratch).policyDigest;
    assert.notEqual(before, after, "a ci.yml edit without manifest refresh must be visible drift");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("policy-digest --check works through a symlinked invocation path", () => {
  // node resolves import.meta.url through symlinks while argv[1] stays
  // literal; the is-main guard must compare realpaths or a symlinked checkout
  // silently exits 0 on a STALE manifest (adversarial repro on macOS /tmp).
  const scratchReal = mkdtempSync(join(tmpdir(), "digest-symlink-"));
  try {
    for (const dir of ["prompts", "extensions", "skills", "templates", "scripts", "docs"]) {
      cpSync(join(root, dir), join(scratchReal, dir), { recursive: true });
    }
    cpSync(join(root, "package.json"), join(scratchReal, "package.json"));
    cpSync(join(root, "manifest.json"), join(scratchReal, "manifest.json"));
    appendFileSync(join(scratchReal, "prompts", "lead.md"), " ");
    const linked = `${scratchReal}-link`;
    symlinkSync(scratchReal, linked);
    try {
      let code = 0;
      let stdout = "";
      try {
        stdout = execFileSync(process.execPath, [join(linked, "scripts", "policy-digest.mjs"), "--check"], { encoding: "utf8" });
      } catch (error) {
        code = error.status;
        stdout = String(error.stdout ?? "");
      }
      assert.equal(code, 1, "a stale manifest must fail even via a symlinked path");
      assert.match(stdout, /manifest_stale|manifest_missing/);
    } finally {
      rmSync(linked, { force: true });
    }
  } finally {
    rmSync(scratchReal, { recursive: true, force: true });
  }
});

test("preflight rejects unknown flags fail-closed (the --stict bug)", () => {
  let code = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [join(root, "scripts", "preflight.mjs"), "--stict"], { encoding: "utf8" });
  } catch (error) {
    code = error.status;
    stderr = String(error.stderr ?? "");
  }
  assert.equal(code, 2, "an unknown flag must refuse, never run non-strict and print ok");
  assert.match(stderr, /unknown_flag/);
  assert.match(stderr, /--strict/, "the hint must name the intended flag");
});
