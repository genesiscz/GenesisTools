import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api, AZURE_DEVOPS_RESOURCE_ID } from "@app/azure-devops/api";
import { azLoginSuggestionBlock } from "@app/azure-devops/lib/az-cli.utils";
import type { AzureConfig, AzureConfigWithTimeLog } from "@app/azure-devops/types";
import { extractTeamFromUrl, parseAzureDevOpsUrl } from "@app/azure-devops/url-parser";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { $ } from "bun";

export async function checkAzureCliLogin(): Promise<void> {
    try {
        await $`az account show`.quiet();
    } catch (error) {
        throw new Error(`Azure CLI not logged in. Run:\n${azLoginSuggestionBlock()}`, { cause: error });
    }
}

export async function buildAdoConfig(url: string): Promise<AzureConfig & { orgId: string }> {
    const { org, project } = parseAzureDevOpsUrl(url);
    const [projectId, orgId] = await Promise.all([Api.getProjectId(org, project), Api.getOrgId(org)]);
    const team = extractTeamFromUrl(url);
    const config: AzureConfig & { orgId: string } = {
        org,
        project,
        projectId,
        orgId,
        apiResource: AZURE_DEVOPS_RESOURCE_ID,
    };

    if (team) {
        config.team = team;
    }

    return config;
}

/**
 * Write the config, keeping settings the caller could not have supplied.
 *
 * This used to write `config` over the whole file. A URL only ever carries org,
 * project and (sometimes) team, so re-running `configure` with a plain project
 * URL silently dropped the configured `team` — and with it the `timelog` block,
 * which holds the Azure Functions key. That key exists nowhere else, so the
 * only recovery was to fetch it again by hand (PR #333 review t9).
 *
 * Project identity is still authoritative from the caller: switching projects
 * must not merge the previous project's ids into the new one.
 */
export function saveAdoConfig(config: AzureConfig, configDir: string): string {
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }

    const configPath = join(configDir, "config.json");
    const merged = { ...readExistingConfig(configPath), ...config };
    writeFileSync(configPath, SafeJSON.stringify(merged, null, 2));
    return configPath;
}

function readExistingConfig(configPath: string): Partial<AzureConfigWithTimeLog> {
    if (!existsSync(configPath)) {
        return {};
    }

    try {
        return SafeJSON.parse(readFileSync(configPath, "utf8"), { strict: true }) as Partial<AzureConfigWithTimeLog>;
    } catch (err) {
        // A corrupt file must not take the new configuration down with it, but
        // it also must not be silent: whatever was in there is about to be
        // replaced rather than merged.
        logger.warn({ err, configPath }, "existing Azure DevOps config is unreadable; writing a fresh one");
        return {};
    }
}
