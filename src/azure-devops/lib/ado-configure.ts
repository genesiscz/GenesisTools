import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api, AZURE_DEVOPS_RESOURCE_ID } from "@app/azure-devops/api";
import type { AzureConfig } from "@app/azure-devops/types";
import { parseAzureDevOpsUrl } from "@app/azure-devops/url-parser";
import { SafeJSON } from "@app/utils/json";
import { $ } from "bun";

export async function checkAzureCliLogin(): Promise<void> {
    try {
        await $`az account show`.quiet();
    } catch {
        throw new Error("Azure CLI not logged in. Run: az login --allow-no-subscriptions --use-device-code");
    }
}

export async function buildAdoConfig(url: string): Promise<AzureConfig & { orgId: string }> {
    const { org, project } = parseAzureDevOpsUrl(url);
    const [projectId, orgId] = await Promise.all([Api.getProjectId(org, project), Api.getOrgId(org)]);
    return { org, project, projectId, orgId, apiResource: AZURE_DEVOPS_RESOURCE_ID };
}

export function saveAdoConfig(config: AzureConfig, configDir: string): string {
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }

    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, SafeJSON.stringify(config, null, 2));
    return configPath;
}
