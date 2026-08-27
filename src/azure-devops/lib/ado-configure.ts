import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api, AZURE_DEVOPS_RESOURCE_ID } from "@app/azure-devops/api";
import { azLoginSuggestionBlock } from "@app/azure-devops/lib/az-cli.utils";
import type { AzureConfig } from "@app/azure-devops/types";
import { extractTeamFromUrl, parseAzureDevOpsUrl } from "@app/azure-devops/url-parser";
import { SafeJSON } from "@genesiscz/utils/json";
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

export function saveAdoConfig(config: AzureConfig, configDir: string): string {
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }

    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, SafeJSON.stringify(config, null, 2));
    return configPath;
}
