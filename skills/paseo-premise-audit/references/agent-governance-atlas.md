# Agent Governance Expected-Capability Atlas

Load only for multi-agent orchestration, agent governance, or agent-workflow
systems — including SLP (Supervisor / Lead / Peer) deployments themselves.

Use this to build the **expected** atlas in step 2. Agent systems are unusually
prone to mechanism-free claims because their vocabulary is borrowed from human
organizations, where the mechanism is a person. "The Lead decides" describes an
outcome; it is only true if something in the system can actually deny a decision
made elsewhere.

## The distributed authority graph

Authority in a governance system is **not** a hierarchy, and auditing it as one
produces false findings in both directions. The honest model has several
independent axes:

| Role | Authority axis |
|---|---|
| Human | intent, priorities, external commitments |
| Supervisor | intent interpretation, architecture discussion, cross-boundary observation and intervention |
| Lead | room topology, sequencing, ownership, integration, acceptance |
| Peer | local engineering judgment and execution within scope |
| Runtime (Paseo) | session lifecycle, transport, routing, notification |
| Artifacts/evidence | durable state and provenance |

So `Supervisor > Lead > Peer` is the wrong shape. The right one is:

```text
Supervisor: broad across space and concern
Lead:       deep on room ownership and acceptance
Peer:       deep on task-local engineering judgment
```

A Supervisor observing more does not make it the Lead's technical superior; a
Peer owning less scope does not make its judgment inside that scope advisory.
Audit findings that assume a strict chain will misread both.

## Responsibilities that should exist

| Responsibility | Authoritative owner | Failure if unowned |
|---|---|---|
| Intent | human | agents optimize a proxy nobody chose |
| Intent interpretation | Supervisor | drift with no detector |
| Task authority grant | one typed channel only | prompt-injected privilege escalation |
| Scope ownership | Lead | two writers, lost work |
| Execution | Peer | — |
| Acceptance | Lead | self-accepting agents |
| Merge/deploy | human | irreversible action without a human |
| Independent review | a Peer that did not write the code | authorship reviewing itself |
| Routing/model resolution | Lead, verified against runtime | silent model substitution |
| Session lifecycle | runtime | zombie agents holding scope |
| Durable truth | artifacts + Git SHA | claims without provenance |
| Reconciliation after intervention | Supervisor → Lead notification | split-brain |

## Mechanism-vs-name checks

| Claimed | Required mechanism |
|---|---|
| Authority / permission | a typed channel a parser can validate, that **fails closed** on anything unrecognized. Authority stated in free prose that the model is asked to respect is not a mechanism — it is a suggestion inside the attack surface. |
| Independent review | a reviewer with a different session, a different workspace, and no authorship of the diff. Same session with a "now review it" prompt is self-review with extra steps. |
| Read-only | enforcement at the tool/hook layer. An instruction not to edit is not read-only. |
| Exact-SHA review | an observed `git rev-parse HEAD` compared to an assigned SHA, with refusal on mismatch. A SHA quoted in a report is a claim. |
| One writer per scope | someone who can detect and refuse the second writer. A convention is not an owner. |
| Acceptance | a decision made against evidence by an actor who did not produce the work. `finished`, `idle`, or exit-0 is a lifecycle event, not acceptance. |
| Observed routing | runtime identity read from the daemon. A model name written in a prompt is text. |
| Escalation | a path that actually reaches a human, plus a defined default when it does not. |
| Recovery | reconciled workspace/Git state before reassignment. Spawning a replacement over unknown state is duplication, not recovery. |
| Idempotent retry | durable identity and binding. A retry loop without it manufactures duplicate work. |

## The central trust boundary

In an agent system, **the prompt is untrusted input**. Any design where
privilege is derived from natural-language text that a model interprets has no
authority mechanism, regardless of how carefully the text is written.

Expected shape: a typed authority block, parsed by code, in a marked region;
everything outside that region is untrusted; unknown fields, duplicate fields,
missing terminators, or unparseable structure make the whole grant invalid;
invalid means **least privilege**, not best-effort. Authority does not carry
over between turns, because a follow-up message is a fresh untrusted input.

Trace this specifically:

- Where is the boundary between the authority region and the body?
- What happens to a field the allowlist does not know? (Ignoring it is a defect;
  it is exactly how an injected field gets tolerated.)
- Does a missing end marker fail closed or parse the whole prompt?
- Can a Peer's own output re-enter as authority anywhere?
- Does the enforcement live in a hook the agent cannot bypass, or in advice?

## Governance-specific taxes to name

- **Coordination tax**: every artifact, queue, review layer, or notification hop
  that replaces a direct owner call without adding a required isolation or
  scaling boundary.
- **Context bottleneck**: forcing all information flow through one orchestrator
  so that its context window becomes the system's throughput limit. Direct
  Supervisor→Peer intervention is a legitimate relief valve — but see split-brain
  below.
- **Split-brain**: any intervention path that changes state without a durable
  notification back to the owner of that state. A Supervisor that can bypass the
  Lead but does not then notify it has created a second, secret command chain,
  and the Lead's model of ownership is now wrong.
- **Ceremony without a decision**: report sections, receipts, and counters that
  no downstream actor reads. Governance artifacts are code with a consumer; an
  artifact with no consumer is cost.
- **Model-class inflation**: routing everything to the strongest model because
  routing is not actually decided by task risk.
- **Fan-out cost**: N concurrent agents is N× tokens and N× daemon load. A
  fan-out whose N is a constant nobody chose is an unpriced decision.
- **Permanent scaffolding**: a "temporary" bypass, test constructor, or manual
  bootstrap that remains the only complete route while the claimed production
  route is disconnected.

## Proof-laundering traps specific to this domain

- an agent's own report cited as evidence for what the agent did — self-reported
  success is a claim, and the file, command, and output are the evidence;
- lifecycle state (`finished`, `idle`, exit 0) cited as acceptance;
- a passing hook unit test cited as proof that the hook is wired into the
  runtime — test the installed path, not just the module;
- a fixture-driven suite cited for a CLI integration that the suite stubs;
- policy documented in a prompt cited as enforcement, when enforcement lives (or
  does not) in an extension;
- an agent asserting it did not read something, treated as isolation;
- prose in a protocol document cited as a guarantee about runtime behavior.

## Questions that most often reverse a verdict here

1. If every prompt in this system were adversarial, which authority survives?
2. Which artifact does a downstream actor actually read, and what does it do
   differently because of it?
3. Where does the system decide, versus where does it merely record?
4. What is the default when the human is absent — stop, or proceed?
5. Which role would notice this specific failure, and with what evidence?
6. If a role were deleted, what breaks — or does its work simply relocate?

## Exoneration

Return `BORING_STANDARD` or `JUSTIFIED_DEVIATION` when the authority mechanism
is typed and fails closed, evidence crosses the production route, roles have
distinct and non-overlapping decision rights, and any coordination cost buys a
named isolation or trust boundary. Governance overhead that prevents an
irreversible action is not overengineering — it is the product.
