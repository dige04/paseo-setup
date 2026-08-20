// Resolve the installed support-script directory without relying on a shell
// profile. PASEO_TEAM_SCRIPTS_DIR is an explicit override for source checkouts
// and custom installs; the default follows where install.{sh,ps1} puts them.
//
// This value is load-bearing, not cosmetic: claude-policy.mts compares the FULL
// path of an ask-lead / watchdog command against this directory, so a mismatch
// between the installer, the provider env and this default turns the Peer's
// sanctioned channel into a rejected command.
import { homedir } from "node:os";
import { join } from "node:path";
import { isEntrypoint } from "./lib-common.mjs";

export function defaultTeamScriptsDir(env = process.env) {
  const teamDir = env.CLAUDE_TEAM_DIR?.trim()
    || join(homedir(), ".claude", "paseo-team");
  return join(teamDir, "scripts");
}

export function resolveTeamScriptsDir(env = process.env) {
  const override = env.PASEO_TEAM_SCRIPTS_DIR?.trim();
  return override || defaultTeamScriptsDir(env);
}

/** Entrypoint check; `moduleUrl` must default to THIS module's url, not the
 * shared helper's, so the default argument stays here. */
export function isMainModule(entry = process.argv[1], moduleUrl = import.meta.url) {
  return isEntrypoint(moduleUrl, entry);
}

if (isMainModule()) {
  console.log(resolveTeamScriptsDir());
}
