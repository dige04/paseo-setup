# Realtime Multiplayer Expected-Capability Atlas

Load only for realtime multiplayer, MMO, or authoritative-simulation systems.

Use this to build the **expected** atlas in step 2, before reading the
repository's own decomposition. The point is to know what a competent system of
this class must own, so that repository vocabulary can be tested against it
rather than believed.

> Provenance: reconstructed for this role pack from the domain-examples section
> of `structural-antipatterns.md` plus established mechanisms in the field. It
> is a lens catalog, not a specification — a system may omit or approximate any
> capability here for a named reason at proportionate cost.

## Responsibilities that should exist

| Responsibility | Authoritative owner | Scaling variable |
|---|---|---|
| Session/connection lifecycle | gateway or session service | concurrent connections |
| Input intake and validation | server simulation | inputs/sec × players |
| Authoritative simulation tick | one owner per world/zone/room | entities × tick rate |
| State replication to clients | replication/interest layer | (entities visible) × clients × rate |
| Interest management (relevance) | replication layer | entity density |
| Client prediction | client, for the locally controlled actor | — |
| Reconciliation/correction | client, against authoritative state | correction frequency |
| Remote-actor smoothing | client interpolation/extrapolation | buffer depth vs latency |
| Durable/economic mutation | transactional owner, not the tick | transactions/sec |
| Persistence and checkpointing | storage owner | write amplification |
| Matchmaking / instancing | separate service | queue depth |
| Anti-cheat / trust boundary | server, always | adversarial input rate |

## Archetype split — the decision most systems get wrong

The central question is per-data-family, not per-system:

**Supersedable state** (positions, velocities, animation, health bars): older
values are obsolete the moment a newer one exists. Wants sequenced latest-state
delivery, unreliable-with-sequencing transport, bounded deltas, and interest
filtering. Reliable ordered delivery here buys head-of-line blocking and pays
for data nobody will ever use.

**Exact work** (trades, purchases, inventory moves, quest completion, currency):
each event matters exactly once. Wants durable identity, idempotency keys, typed
outcomes, and a real commit mechanism.

Getting these backwards is the classic archetype defect in both directions:

- exact transactional work modeled as latest-state → silent loss, duplication;
- rapidly supersedable state journaled as exact work → bandwidth and latency tax
  for values already obsolete on arrival.

Not every item that contains the word "item" is durable. Ask where the durable
ownership boundary actually is: an item held by two players across a trade is
durable and deserves transactional machinery; a corpse drop on the ground after
a server crash usually is not, and buying 2PC for it is imported realism. Name
the boundary explicitly rather than escalating everything that sounds valuable.

## Mechanism-vs-name checks

Each row is a claim the repository may make. The mechanism column is what must
exist for the claim to be true. A name without its mechanism is a
mechanism-free claim.

| Claimed | Required mechanism |
|---|---|
| Client prediction | local input application **plus** retained inputs or deterministic state sufficient to correct/resimulate. One position step at submit time is not prediction. |
| Reconciliation | authoritative state/progress **plus** a rule for correcting or replaying local prediction. Fabricating a partial authoritative record from an ACK is not reconciliation. |
| Server-authoritative click-to-move | an owned navigation mechanism: validated destination plus path/corridor/support facts, or another explicit authoritative route. Moving directly toward a target does not acquire those semantics by being named navigation. |
| Interest management | a relevance computation with a defined update rule and a bounded output set. Broadcasting to everyone with a client-side filter is not interest management; it moves the cost, it does not remove it. |
| Lag compensation | retained historical state and an explicit rewind/validation window. A tolerance constant is not lag compensation. |
| Idempotency | durable identity and binding, not a counter or a timer. |
| Durability | a durable commit mechanism, not a write that usually lands. |
| Rollback netcode | deterministic simulation, retained inputs, and a resimulation path. Partial state copies are not rollback. |

## Expected-shape defaults

Large multiplayer worlds normally: predict the **locally controlled actor
only**; deliver authoritative snapshots for remote actors with interpolation or
extrapolation; and apply interest management so replication cost does not scale
with total world population.

Full rollback, or exact journaling for every remote entity, is a real technique
with a real cost — it requires a specific product justification (fighting-game
frame precision, deterministic lockstep RTS). Finding it applied to a large open
world without that justification is a strong archetype-defect candidate.

## Amplification routes to trace

When a serious candidate appears, name the exact route by which its cost grows:

- per-tick allocation × tick rate × entities;
- replication cost × visible entities × clients (the quadratic trap);
- full-state publication where a bounded delta would do;
- per-client product where one shared product would be safe;
- pathfinding or reconstruction at tick frequency instead of on demand;
- global ordering or a single lock across independent zones/rooms;
- catch-up bursts after a stall, delivering state that is already obsolete;
- reliable retransmission of superseded state.

## Failure and overload behavior to check

- What happens when a client falls behind — bounded queue, dropped state, or
  unbounded buffer growing until the session dies?
- Is overflow converted into session death, and is that visible as a typed
  outcome or as an untyped disconnect?
- Does recovery revive stale work that should have been discarded?
- Is there backpressure at all, or only retry?
- Does a slow client degrade other clients (shared queue, shared lock)?

## Proof-laundering traps specific to this domain

- transport send, ACK, queue drain, or connection state treated as application
  acceptance or player-visible outcome;
- a bot/replica/headless client benchmark cited for a production path it never
  traverses;
- a green single-process integration test cited for a distributed authority
  claim;
- log presence or timestamp adjacency used as proof that a mutation committed;
- downstream code parsing payloads or timing to infer a typed semantic product
  the owner should publish directly.

## Exoneration

Return `BORING_STANDARD` or `JUSTIFIED_DEVIATION` when the production mechanism
has the required information and owner, the counterexample is handled, and any
deviation serves a named constraint at proportionate cost. Realtime simulation
is genuinely hard; visible complexity here is often the domain, not the defect.
