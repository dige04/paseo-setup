---
name: paseo-premise-audit
description: Audit a whole project for a wrong system archetype by deriving expected product capabilities before trusting repository vocabulary. Use only for an explicitly requested broad premise audit, not for ordinary architecture review or one named design concern.
---

# Paseo Premise Audit

Determine whether the project is built around the right system archetype, not
merely whether its current modules are internally consistent. Read-only unless
the user separately requests changes.

Under SLP this runs as a `solution-architect` **Peer**, briefed read-only by the
Lead. It observes and judges architecture; it does not own implementation. You
produce a verdict and evidence — the Lead owns acceptance and a human owns any
direction change.

A Supervisor may **commission** this audit and read its verdict, but cannot run
it: the Claude policy gives the Supervisor no shell authority beyond the
read-only watchdog, and no file-read surface for tracing production routes. A
Supervisor that tried would be blocked at the first `Bash` call. Commission it
by sending the Lead an observation asking for a premise-audit Peer.

## Relationship to the other review instruments

| Instrument | Question | Bound to |
|---|---|---|
| `paseo-ocr-reviewer` | is this commit acceptable? | one exact SHA |
| `paseo-ultra-review` | what might be wrong in this scope? | a scope, maximum recall |
| this skill | is the whole thing the right kind of system? | the whole project |

This is the only one of the three that is allowed to conclude the codebase is
excellent and still wrong. A green suite, clean modules, and a passing review at
the other two levels are **inputs** here, never the answer.

## Boundaries

- Work at the whole-project or named broad-system boundary the user requested.
- Derive the expected product model **before** treating repository terminology,
  architecture docs, tests, or benchmarks as authoritative. Vocabulary is a
  claim, not evidence.
- Treat passing proof as evidence about an implementation, not proof that the
  mechanism should exist.
- Complexity is a finding **only** when it lacks a required product need, owner,
  lifecycle, consumer, scaling contract, or failure contract. Complexity that
  the domain genuinely requires is not overengineering.
- Do not turn a broad audit into implementation, issue creation, or a second
  review workflow.
- Ask only when one missing fact would reverse the verdict and cannot be bounded
  with an explicit stated assumption.

Load the domain profile matching the system under audit before building the
expected capability map. Do not load an unrelated profile:

- realtime multiplayer / MMO / authoritative simulation →
  [references/realtime-multiplayer-atlas.md](references/realtime-multiplayer-atlas.md)
- agent orchestration / multi-agent governance →
  [references/agent-governance-atlas.md](references/agent-governance-atlas.md)

If no profile matches, say so and build the expected atlas from first principles
and established mechanisms in that domain. An absent profile is a stated
limitation, not a reason to skip step 2.

## Audit slice

Judge work by **product responsibility**, not repository module. A slice may
cross modules, and one module may contain several slices. Each slice identifies:

- job to be done and production consumer;
- authoritative owner, state, and lifecycle;
- inputs, outputs, and trust boundaries;
- scaling or adversarial variable;
- failure, overload, and backpressure behavior;
- reusable-platform versus application responsibility.

## Procedure

1. **Set the claim.** State the product category, requested boundary, expected
   outcome, material assumptions, and completion rule.
2. **Build the expected atlas.** From product needs and established domain
   mechanisms, list the responsibilities that should exist, their likely owners,
   scaling variables, and the work that must be bounded or isolated. Do this
   *before* reading the repository's own decomposition.
3. **Build the observed map.** Trace production entry points, authoritative
   state, durable effects, expensive operations, queues, schedulers, external
   outputs, deployment boundaries, and cited proof. Do not copy the repository's
   decomposition without testing it.
4. **Compare every slice.** What demonstrated requirement forces each mechanism?
   Does cost follow useful work? Are normal and exceptional paths reversed?
   Does removing or relocating the mechanism lose an established requirement?
5. **Deep-check serious candidates.** Trace real callers and consumers, name the
   exact amplification route, construct the cleaner counterfactual, identify the
   machinery that disappears under it, give the strongest counterargument, and
   state the evidence that would falsify the finding.
6. **Check coverage.** Stop only when every discovered ingress, authoritative
   state family, durable effect, expensive operation, and external output is
   either represented in the coverage ledger or explicitly excluded by scope.

Use [references/structural-antipatterns.md](references/structural-antipatterns.md)
as search lenses during steps 4–5, and
[references/proof-debt-catalog.md](references/proof-debt-catalog.md) when the
cited evidence itself looks like the weak link. Both are lens catalogs, not
checklists every design must satisfy.

Do not report generic improvements. Classify each supported candidate as:
architecture defect, owner defect, implementation drift, justified divergence,
quarantined scaffold, or insufficient evidence.

## Verdict and output

Lead with exactly one verdict:

- `KEEP_FOUNDATION`
- `REPAIR_FIRST`
- `REDIRECT_RECOMMENDED`
- `STOP_AND_REDIRECT`
- `INSUFFICIENT_EVIDENCE`

Then provide only the material sections needed to support it:

1. expected-versus-observed map;
2. compact coverage ledger and exclusions;
3. ranked findings with production evidence, hidden premise, tax, and
   amplification route;
4. counterfactual architecture, and the machinery removed or relocated under it;
5. counterargument and falsifier for each serious finding;
6. `STOP_OPTIMIZING` and `PROBABLY_JUSTIFIED` items;
7. prioritized decisions and realistic fitness scenarios.

Make the best evidence-supported judgment available. Expose your assumptions,
but do not end with an unranked option menu or an interview questionnaire — an
audit that returns the question to the user has not audited anything.

`INSUFFICIENT_EVIDENCE` is a real verdict and the correct one when the
production route could not be traced. It is not a polite way to avoid
committing; it must name exactly what was unreachable and what would resolve it.
