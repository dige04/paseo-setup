PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-031-scout-04
PROJECT_ID: checkout-service
DISPOSITION: repository-scout
MODE: read-only
ASSIGNED_HOST_ID: win-primary
ASSIGNED_PASEO_PROVIDER: claude-peer
ASSIGNED_MODEL: <pi-provider>/<model-id>
ASSIGNED_THINKING: low

OWNED_SCOPE: Read access to the repository (shared workspace).
EXCLUDED_SCOPE: All writes. All command execution beyond read-only inspection.

EDIT_AUTHORITY: denied
COMMIT_AUTHORITY: denied
PUSH_TASK_BRANCH_AUTHORITY: denied
FORCE_PUSH_AUTHORITY: denied
MERGE_AUTHORITY: denied
DEPLOY_AUTHORITY: denied
VERIFICATION_PROFILE: read-only
RETURN_CHANNEL: paseo

PASEO_TEAM_TASK_V3_END

TASK_BODY_BEGIN

OBJECTIVE:
You are scout-04 of 10 in an ultra review of the discount recalculation change.
Find bugs. Maximum recall is the goal: report every candidate you find, even
speculative, low-confidence, or hard-to-classify ones. Another pass verifies
them later — your job is not to be right, it is to not miss anything.

Nine other scouts are running independently on the same scope with different
assigned angles. Do not try to guess what they are covering or divide labour
with them; overlap is intentional and is how candidates get cross-validated.

REVIEW_SCOPE:
Commit range <base-sha>..<candidate-sha>. Inspect the full relevant production
surface, not only the visible diff — a defect introduced by this change may
live in an untouched caller.

CHANGE_INTENT:
Move order-level discount recalculation out of the checkout flow into the
pricing owner. The change claims no behavior difference for single-item orders.

ASSIGNED_CONCERNS:
- G04 — error masking, fallback, retry, partial failure, invariant handling.
  Angles: what happens when the pricing call fails midway; whether a fallback
  path has different semantics from the primary; whether a caught error becomes
  a silently wrong number instead of a failure; whether retries can double-apply
  a discount; what an empty or partial pricing response produces.
- G09 — caller and schema contracts.
  Angles: every caller of the moved function; whether the new owner can actually
  compute what its callers now expect from the inputs it receives; serialized or
  persisted shapes that still assume the old owner.

INCIDENTAL_AUTHORITY:
You may report ANY in-scope bug you notice, including ones far outside G04 and
G09. Do not suppress a finding because it belongs to someone else's angle.

REPOSITORY_CONTRACTS:
- WORKSPACE_PROTOCOL.md governs ownership boundaries.
- Money is integer minor units everywhere; a float in a money path is a bug.
- src/pricing/** is the intended owner; src/checkout/** must not recompute.

PRIOR_ROUND_WARNINGS:
- Round 1 F003 (rounding drift in multi-item orders) was confirmed and fixed in
  <sha>. Check the fix rather than re-reporting the original.
- Round 1 F007 (suspected race in cart mutation) was rejected as a false
  positive. You may revive it if you see evidence — a prior rejection does not
  bar the candidate.

CONSTRAINTS — READ-ONLY, ENFORCED:
- Do not edit, create, stage, format, generate, or mutate any file.
- Do not run tests, builds, package managers, proof commands, or task runners.
  Static read-only inspection only.
- Do not create or coordinate other agents.
- Do not fix anything you find. Report it.

REQUIRED HANDOFF:
Report every candidate in this shape, and prefer too many over too few:

CANDIDATE <n>
  TITLE:
  SEVERITY: P0 | P1 | P2 | P3
  CONFIDENCE: high | medium | low
  SOURCE_POINTER: <file:line>
  EVIDENCE: <what you observed at that location; "unknown" is allowed>
  CONTRACT_VIOLATED: <expected behavior vs observed>
  FAILURE_MODE: <how it breaks, under what condition/input/timing>
  DURABLE_SOLUTION: <owner-clean long-term fix hypothesis>
  DISCONFIRMING_CHECK: <a read-only check that would prove this false>

Then:

FILES_READ:
CONCERNS_COVERED: G04, G09
INCIDENTAL_CANDIDATES: <count>
COVERAGE_GAPS: <anything in your angles you could not reach, and why>

If you found nothing, say so explicitly rather than padding. If you could not
reach part of your assigned angle, say that too — a silent gap reads as
coverage.

TASK_BODY_END
