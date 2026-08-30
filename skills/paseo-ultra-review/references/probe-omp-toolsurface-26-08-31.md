# Probe capture — omp seat tool surface (2026-08-31)

Backing artifact for the "Measured, not assumed" claim in `SKILL.md` §Which
scouts are actually enforced read-only. Recorded verbatim from the probe
agent's final response; re-run instruction at the bottom supersedes this
capture if the two ever disagree.

- Agent: `7a2ebbcc-1671-4016-a7de-2b5751f718f6`, provider `omp/google-antigravity/gemini-3.7-flash`, mode `ask`
- Workspace: paseo-harness root, daemon Paseo (local), 2026-08-31
- Prompt: enumerate own tool list only; no tool execution

## Verbatim response

```
1. PASEO_TOOLS:
NONE

2. PASEO_LIKE:
task
hub
create_agent
send_agent_prompt
get_agent_status
list_agents
cancel_agent
archive_agent
kill_agent
update_agent
get_agent_activity
set_agent_mode
list_pending_permissions
respond_to_permission
create_workspace
list_workspaces
archive_workspace
rename_workspace
list_workspace_scripts
start_workspace_script
stop_workspace_script
create_schedule
list_schedules
inspect_schedule
pause_schedule
resume_schedule
delete_schedule
update_schedule
schedule_logs
run_schedule_once
create_heartbeat
delete_heartbeat
list_providers
list_models
list_profiles
inspect_provider

3. TOTAL_TOOLS:
73
```

Reading: zero `mcp__paseo__*` names; 35 bare-named orchestration tools + `task`
+ `hub`. Any prefix-based probe or filter is blind on omp seats.

## Re-run instruction (the durable form of this evidence)

Create an omp agent in any workspace, mode `ask`, with exactly this prompt, and
compare against the capture above:

```
This is a tooling-surface probe. Do NOT execute any tool. Answer from your own
available-tool list only. Report: (1) every tool name starting with
"mcp__paseo__" or NONE; (2) any other tool named like orchestration
(create_agent, spawn, subagent, delegate) or containing "paseo"; (3) total
tool count. If you cannot enumerate, say CANNOT_ENUMERATE.
```

A Paseo or omp update that changes the naming convention makes the SKILL text
stale — re-run, replace this capture, update the SKILL numbers.
