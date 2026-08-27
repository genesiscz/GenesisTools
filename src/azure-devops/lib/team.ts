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
 *
 * Returns null when neither is set. A team is never a precondition: it only
 * narrows an iteration list to the ones that team subscribes to. Callers fall
 * back to the project-wide classification nodes instead of failing.
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
