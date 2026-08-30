# Anti-pattern catalog

Global across projects — these are model failure modes, not project properties. A project may
**disable** an entry in its `WORKSPACE_PROTOCOL.md`; it may not add entries here (a repo-local
lesson belongs in that repo's protocol; promotion to this file requires ≥2 episodes across
distinct projects and the `role_global` bucket — see `templates/SUPERVISOR_NOTEBOOK.md`).

Every entry needs all six fields. An entry without a `detector` is advice, not a mechanism.
Entry states: `candidate` (1 episode) → `pattern` (≥2) → `mechanism` (an assert or gate runs) →
`disproved` (kept, with the reason — never deleted, so the same bad idea is not relearned).

---

## AP-01 — red test mints an undecided contract

```yaml
id:          AP-01
name:        red test mints an undecided contract
bucket:      role_global
severity:    high
state:       pattern        # SLP session episode + Demonthorn corpus; assert not yet wired
detector:
  kind:      deterministic + neutral-question
  signals:
    - diff adds a test referencing symbol S
    - the SAME diff adds S to production code
    - S is a new field on an ALREADY-EXISTING type, a new public surface
      (method/endpoint/table/column), or a shape change to a type with consumers
  excludes:                 # legitimate TDD — do not fire
    - S lives entirely inside a new module this PR creates
    - S already appears in an ADR / plan / WORKSPACE_PROTOCOL that predates the diff
question:    "Contract của <S> đã được chốt ở đâu chưa? Nếu chưa — đây có phải là quyết
              định architecture mà test đang thay bạn quyết không?"
action:      no settled source → REOPEN_REQUEST to Lead. The Peer does not decide.
evidence:    [SLP session 2026-08 (User.points episode), Demon sources message.txt]
```

**Mechanism.** Requirement carries business intent while the contract is undecided (điểm tính
theo tiền hay số đơn? lưu trong `User` hay `LoyaltyAccount` hay derive từ purchase history?).
The agent starts TDD anyway: `expect(user.points).toBe(100)`. That one line has silently decided
an architecture question — points is state **on User**. The test goes red; the agent goes green
by adding `User.points`; an undecided question is now a load-bearing assumption. Planning does
not prevent this: a plan that closed every contract at this grain would be the implementation
written in markdown.

## AP-01r — refactor variant: the bridge the test depends on

```yaml
id:          AP-01r
name:        transitional bridge becomes permanent because a test depends on it
bucket:      role_global
severity:    critical       # compounding: later models read the test as pinning correct behavior
state:       pattern
detector:
  kind:      deterministic
  signals:
    - repo is in a transition state (old and new contract coexist)
    - diff adds a symbol matching /adapter|bridge|compat|legacy|shim|_v1|_old/
      OR adds a re-export covering both shapes
    - a test in the same diff references the OLD shape
action:      STOP — not a question. Ask Lead: "bridge này là transition có ngày hết hạn,
             hay đã thành architecture?"
evidence:    [SLP session 2026-08 (User.points → LoyaltyAccount refactor)]
```

**Why severity is higher than AP-01:** during a refactor the old test fails, the agent
manufactures a temporary compatibility layer to compile, the test starts depending on the
layer, and temporary becomes permanent. A later model with no memory of the original context
reads the test as pinning correct behavior and **bends the implementation to satisfy the wrong
test**. The doctrine catalog names the end state exactly: *"a local workaround survives after
the owning foundation can be repaired, so the accommodation becomes permanent architecture."*

## AP-02 — unreachable positive path in a fail-closed system

```yaml
id:          AP-02
name:        unreachable positive path in a fail-closed system
bucket:      role_global
severity:    high
state:       mechanism      # enforced by test/reconcile-qualification.test.mjs
detector:
  kind:      deterministic
  signals:
    - a branch whose guard conjoins fields derived from the same source value
      (e.g. `code === 1 && error === null` where both derive from one error object)
    - a state in a state-enum that no test reaches via the REAL producer
    - a run whose positive-outcome count is 0, reported as successful validation
question:    "Input nào sinh ra positive outcome? Chứng minh end-to-end qua producer
              THẬT, không qua fixture inject."
action:      REOPEN — a fail-closed result is not evidence until the true-positive path
             has been exercised at least once.
evidence:    [agent 5ff71165 · 2026-08-30 · reconcile-observer.mjs:175 — 24 green tests,
              two self-reviews, one live pass; feature had never produced output once]
```

**Standing rule derived from this entry:** every fail-closed gate in this harness ships with a
**positive control** — one test that reaches the allowed state through the real producer.
Until that exists the gate is `candidate`, not `mechanism`, regardless of how many refusal-path
tests are green. `test/reconcile-qualification.test.mjs` is the reference implementation.

## AP-03 — test-shaped production surface

```yaml
id:          AP-03
name:        production API/state whose only consumer is a test or proof harness
bucket:      role_global
severity:    medium
state:       candidate      # imported from Demon sources message.txt; no local episode yet
detector:
  kind:      deterministic
  signals:
    - a production export/field/branch/instrumentation referenced ONLY from test/
    - a test asserting a retired name, source substring, help text, file inventory,
      private call order, phase label, or generated report shape that is not a
      public machine contract
    - a fixture constructing a parallel runtime model, then gating production on it
action:      delete the surface with the test, or promote the contract to a real
             consumer first
evidence:    [Demon sources message.txt — Test Discipline]
```

Companion rules from the same source, kept as discipline (no detector, so not entries):
tests protect a **settled** contract — RED/GREEN only when contract and owner are already
decided (the boundary AP-01 patrols); after a hard cut, derive invalid inputs from **current**
constants (`WIDTH ± 1`), never from remembered retired values; ask of every test whether it
stays meaningful without git history.

---

## Wiring status

| Entry | Enforced by | State |
|---|---|---|
| AP-01 / AP-01r | not yet — needs diff+typecheck integration in the review lane | pattern |
| AP-02 | `test/reconcile-qualification.test.mjs` + rule in review instruments | **mechanism** |
| AP-03 | not yet — greppable signals, candidate for `governance-graph --assert` | candidate |
| AP-04 | `findingAction()` gate in `ultra-review-report.mjs` + mandatory root-cause reopen in `paseo-ultra-review` SKILL | **mechanism** (gate) + rule (reopen) |

The deterministic assert tier (`A1–A6` in `research/design/01- §7.1`: two writers on one scope,
reviewer sharing engineer's worktree, orphaned peer after Lead death, observed≠requested model,
exit-0-as-proof, parallel-after-worktree) lives in `governance-graph.mjs` scope and is tracked
there, not here — this file is for *model behavior* patterns that need an episode trail.

## AP-04 — symptom-patching a converged root

```yaml
id:          AP-04
name:        point-fixing N findings that share one owning mechanism
bucket:      role_global
severity:    high
state:       pattern       # 2 episodes: agent 5ff71165 tilde patches; Lead round-1 isPathInside
detector:
  kind:      deterministic + neutral-question
  signals:
    - ≥2 findings in one review whose evidence cites the same function,
      owner, or lifecycle mechanism
    - the applied fixes touch the citing call sites but not the shared owner
    - convergence count on one finding ≥ 3 while the fix is a one-line guard
      at the reported line
question:    "Vì sao N trace độc lập gặp nhau ở đúng chỗ này? Nếu chúng là một
              gốc — owner của gốc đó là ai, và fix có đang sống ở owner không?"
action:      STOP before fixing any of the group. Dispatch an architect-Peer
             with an outcome-level brief (root or independent? smallest durable
             design?) carrying REOPEN_WHEN and explicit permission to counter
             the Lead's grouping. Fix at whatever level the ruling lands.
evidence:    [UR1 2026-08-30 — 7 scouts → isPathInside; Lead patched lexically
              in place while F004/F024/S10-C1 cited the same uncanonicalized-
              path root. docs/ultrareview/26-08-30-reconciler-hardening-round-1.md]
```

**Mechanism.** Convergence is the review's strongest signal, and it is exactly
the signal a busy Lead converts into a checklist: seven reports → seven (or
one) point patches, each provably "fixing" its cited line, none owning the
mechanism they share. The doctrine catalog names the end state: *"cleanup,
retry, polling, or timeout logic grows at callers because no owner exposes a
complete terminal transition."* The star topology makes this worse — when the
dispatcher is also the writer and the acceptor, no downstream node can push the
root question back.
