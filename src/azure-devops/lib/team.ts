/**
 * Team resolution for team-scoped Azure DevOps endpoints.
 */

import type { AzureConfig } from "@app/azure-devops/types";

export interface TeamResolution {
    team: string;
    source: "flag" | "config";
}

/**
 * Resolve the team from an explicit `--team` flag, falling back to config.
 * Returns null when neither is set; the caller prints the fix.
 */
export function resolveTeam(config: AzureConfig, explicit?: string): TeamResolution | null {
    const flag = explicit?.trim();

    if (flag) {
        return { team: flag, source: "flag" };
    }

    const fromConfig = config.team?.trim();

    if (fromConfig) {
        return { team: fromConfig, source: "config" };
    }

    return null;
}

/** Message shown when no team is configured and none was passed. */
export const NO_TEAM_MESSAGE = [
    "No Azure DevOps team is configured.",
    "",
    "This command reads team settings, so it needs a team name. Either:",
    '  1. Pass it for this run:   tools azure-devops sprint --team "<Your Team>"',
    "  2. Store it in config:     tools azure-devops configure \\",
    '       "https://dev.azure.com/{org}/{project}/_backlogs/backlog/{team}/Stories"',
    "",
    'Or add "team": "<Your Team>" to .claude/azure/config.json by hand.',
].join("\n");
