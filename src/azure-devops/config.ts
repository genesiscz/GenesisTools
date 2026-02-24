/**
 * Azure DevOps CLI - Configuration loading and management
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AzureConfig, AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";
import { formatRelativeTime } from "@app/utils/format";

export function getRelativeTime(date: Date): string {
    return formatRelativeTime(date, { rounding: "round" });
}

/**
 * Search for config file starting from cwd, up to 3 parent levels
 */
export function findConfigPath(): string | null {
    const configName = ".claude/azure/config.json";
    let currentDir = process.cwd();

    for (let i = 0; i < 4; i++) {
        // current + 3 levels up
        const configPath = join(currentDir, configName);

        if (existsSync(configPath)) {
            return configPath;
        }

        const parentDir = dirname(currentDir);

        if (parentDir === currentDir) {
            break; // reached root
        }
        currentDir = parentDir;
    }

    return null;
}

/**
 * Get the config directory for the current project (in cwd)
 */
export function getLocalConfigDir(): string {
    return join(process.cwd(), ".claude/azure");
}

/**
 * Load config from file or return null if not found
 */
export function loadConfig(): AzureConfig | null {
    const configPath = findConfigPath();

    if (!configPath) {
        return null;
    }

    try {
        return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
        return null;
    }
}

/**
 * Require config or exit with helpful error
 */
export function requireConfig(): AzureConfig {
    const config = loadConfig();

    if (!config) {
        console.error(`
❌ No Azure DevOps configuration found.

Run --configure with any Azure DevOps URL from your project:

  tools azure-devops --configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
  tools azure-devops --configure "https://myorg.visualstudio.com/MyProject/_queries/query/..."

This will create .claude/azure/config.json in the current directory.
`);
        process.exit(1);
    }

    return config;
}

/**
 * Load config with TimeLog settings or exit with helpful error
 */
export function requireTimeLogConfig(): AzureConfigWithTimeLog {
    const config = loadConfig() as AzureConfigWithTimeLog | null;

    if (!config) {
        console.error(`
❌ No Azure DevOps configuration found.

Run configure with any Azure DevOps URL from your project:

  tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
`);
        process.exit(1);
    }

    if (!config.orgId) {
        console.error(`
❌ Organization ID not found in config.

Re-run configure to update your config:

  tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems" --force
`);
        process.exit(1);
    }

    if (!config.timelog?.functionsKey) {
        console.error(`
❌ TimeLog configuration not found.

Run the auto-configure command to fetch TimeLog settings:

  tools azure-devops timelog configure

This will automatically fetch the API key from Azure DevOps Extension Data API.
`);
        process.exit(1);
    }

    return config;
}

/**
 * Get current user for TimeLog or exit with helpful error
 */
export function requireTimeLogUser(config: AzureConfigWithTimeLog): TimeLogUser {
    const user = config.timelog?.defaultUser;

    if (!user) {
        console.error(`
❌ TimeLog user not configured.

Add defaultUser to .claude/azure/config.json timelog section:

"timelog": {
  "functionsKey": "...",
  "defaultUser": {
    "userId": "<your-azure-ad-object-id>",
    "userName": "<Your Display Name>",
    "userEmail": "<your-email@example.com>"
  }
}
`);
        process.exit(1);
    }

    return user;
}
