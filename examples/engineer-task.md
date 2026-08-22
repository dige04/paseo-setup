# Example — engineer task (write)

Ví dụ brief V3 Lead gửi cho Engineer Peer. Authority block nằm giữa
`PASEO_TEAM_TASK_V3_BEGIN`/`END`; body bên dưới là untrusted text.

```text
PASEO_TEAM_TASK_V3_BEGIN

TASK_ID: T-001
PROJECT_ID: team-test-repo
DISPOSITION: engineer
MODE: write

ASSIGNED_HOST_ID: win-primary
ASSIGNED_PASEO_PROVIDER: pi-peer
ASSIGNED_MODEL: <pi-provider>/<model-id>
ASSIGNED_THINKING: medium
WORKSPACE_REF: worktree:../worktrees/T-001
AGENT_REF:

EXPECTED_BASE_SHA: <base-sha>
ASSIGNED_CANDIDATE_SHA:

OWNED_SCOPE: calculator.py, test_calculator.py
EXCLUDED_SCOPE: any other file; no deploy, no external system changes

EDIT_AUTHORITY: allowed
COMMIT_AUTHORITY: allowed
PUSH_TASK_BRANCH_AUTHORITY: denied
FORCE_PUSH_AUTHORITY: denied
MERGE_AUTHORITY: denied
DEPLOY_AUTHORITY: denied

VERIFICATION_PROFILE: focused-test
RETURN_CHANNEL: paseo

PASEO_TEAM_TASK_V3_END

TASK_BODY_BEGIN

OUTCOME:
calculator.py handles divide-by-zero and negative-sqrt inputs the way its
existing tests already specify, without those assertions being changed.

CHANGE_BOUNDARY:
calculator.py and test_calculator.py. Read wider if callers matter; this is a
hint about where the change lands, not a limit on what you may investigate.

INVARIANTS:
- No existing test assertion is edited to make a failure disappear.
- Error behavior is the same whether the input is literal or computed.

DEPENDS_ON: none — this task is on the frontier.

REOPEN_WHEN:
- The two tests encode contradictory expectations, so no single behavior
  satisfies both.
- The edge case belongs to a caller or a shared numeric helper rather than to
  calculator.py — do not add a local guard to paper over the wrong owner.

ACCEPTANCE:
- python -m pytest test_calculator.py --tb=short passes, with the output shown.
- git status --porcelain is empty after the final commit.
- Note that a green suite alone is not acceptance: state what the observed
  behavior now is for each edge case.

KNOWN_EVIDENCE:
- test_calculator.py currently has two failing tests (divide by zero, sqrt of
  negative input).
- The failures reproduce with: python -m pytest test_calculator.py --tb=short

QUESTIONS TO ANSWER:
- Should sqrt(-1) raise ValueError, or return a domain-error sentinel? Choose
  the option that satisfies the existing test expectations.

CONSTRAINTS:
- Order is mandatory: format → test → commit → check clean.
- After your final commit, `git status --porcelain` must print nothing.
- Report CANDIDATE_SHA = `git rev-parse HEAD` (COMMIT_AUTHORITY was granted).
- PUSH_TASK_BRANCH_AUTHORITY: denied — do not push; the Lead integrates.

REQUIRED HANDOFF:
- FILES_CHANGED, COMMANDS_RUN, exact test output summary
- CANDIDATE_SHA, BRANCH, WORKTREE_CLEAN
- RISKS, OPEN_QUESTIONS

TASK_BODY_END
```
