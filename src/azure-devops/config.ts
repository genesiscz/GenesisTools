/**
 * Azure DevOps CLI - Configuration loading and management
 */

import { readFileSync } from "node:fs";
import {
    azureDataDir,
    CONFIG_ENV_VAR,
    CONFIG_FLAG,
    ConfigPathError,
    type ConfigPathInput,
    configPathSourceLabel,
    explicitConfigPath,
    resolveConfigPath,
} from "@app/azure-devops/lib/config-path";
import type { AzureConfig, AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";

export function getRelativeTime(date: Date): string {
    return formatRelativeTime(date, { rounding: "round" });
}

let configFlag: string | undefined;

/** Remember the value of the global --config option for the rest of the run. */
export function setConfigFlag(value: string | undefined): void {
    configFlag = value;
}

function activeConfigInput(): ConfigPathInput {
    return {
        flag: configFlag,
        envValue: env.paths.getAzureDevopsConfig(),
        searchFrom: env.paths.getClarityProjectCwd(),
        cwd: process.cwd(),
    };
}

/**
 * The config file: --config, then AZURE_DEVOPS_CONFIG, then a search from cwd up to 3 parent levels.
 * Throws a ConfigPathError when an explicit path is not a readable file.
 */
export function findConfigPath(): string | null {
    return resolveConfigPath(activeConfigInput())?.path ?? null;
}

/** The path --config or AZURE_DEVOPS_CONFIG names, whether or not the file exists yet. */
export function getExplicitConfigPath(): string | null {
    return explicitConfigPath(activeConfigInput())?.path ?? null;
}

/**
 * Get the config directory: the folder of an explicit config, otherwise `.claude/azure` in cwd.
 * The tasks and wiki folders live in it.
 */
export function getLocalConfigDir(): string {
    return azureDataDir(activeConfigInput());
}

/**
 * Extract the short org name from config.org URL.
 * Handles both "https://dev.azure.com/MyOrg" and "https://myorg.visualstudio.com" formats.
 */
export function extractOrgName(orgUrl: string): string | null {
    const devAzureMatch = orgUrl.match(/dev\.azure\.com\/([^/]+)/i);

    if (devAzureMatch) {
        return devAzureMatch[1];
    }

    const vsMatch = orgUrl.match(/([^/.]+)\.visualstudio\.com/i);

    if (vsMatch) {
        return vsMatch[1];
    }

    return null;
}

/**
 * Load config from file or return null if not found.
 */
export function loadConfig(): AzureConfig | null {
    const found = resolveConfigPath(activeConfigInput());

    if (!found) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(found.path, "utf-8"));
    } catch (error) {
        if (found.source === "search") {
            // A searched file is optional, so it falls through to "no configuration", but the reason must not vanish.
            logger.warn({ err: error, path: found.path }, "azure-devops: found config cannot be parsed, ignoring it");
            return null;
        }

        const reason = error instanceof Error ? error.message : String(error);

        throw new ConfigPathError(
            `Azure DevOps config cannot be parsed: ${found.path} (from ${configPathSourceLabel(found.source)}): ${reason}`
        );
    }
}

function loadConfigOrExit(): AzureConfig | null {
    try {
        return loadConfig();
    } catch (error) {
        if (error instanceof ConfigPathError) {
            out.error(`\n❌ ${error.message}\n`);
            process.exit(1);
        }

        throw error;
    }
}

/**
 * Require config or exit with helpful error
 */
export function requireConfig(): AzureConfig {
    const config = loadConfigOrExit();

    if (!config) {
        out.error(`
❌ No Azure DevOps configuration found.

Run configure with any Azure DevOps URL from your project:

  ${toolCommand("azure-devops configure")} "https://dev.azure.com/MyOrg/MyProject/_workitems"
  ${toolCommand("azure-devops configure")} "https://myorg.visualstudio.com/MyProject/_queries/query/..."

This will create .claude/azure/config.json in the current directory.
To use a config file elsewhere, pass ${CONFIG_FLAG} <path> or set ${CONFIG_ENV_VAR}.
`);
        process.exit(1);
    }

    return config;
}

/**
 * Load config with TimeLog settings or exit with helpful error
 */
export function requireTimeLogConfig(): AzureConfigWithTimeLog {
    const config = loadConfigOrExit() as AzureConfigWithTimeLog | null;

    if (!config) {
        out.error(`
❌ No Azure DevOps configuration found.

Run configure with any Azure DevOps URL from your project:

  ${toolCommand("azure-devops configure")} "https://dev.azure.com/MyOrg/MyProject/_workitems"
`);
        process.exit(1);
    }

    if (!config.orgId) {
        out.error(`
❌ Organization ID missing from config.

Re-run configure to fetch the org ID:

  ${toolCommand("azure-devops configure")} "https://dev.azure.com/MyOrg/MyProject/_workitems"
`);
        process.exit(1);
    }

    if (!config.timelog?.functionsKey) {
        out.error(`
❌ TimeLog configuration not found.

Run the auto-configure command to fetch TimeLog settings:

  ${toolCommand("azure-devops timelog configure")}

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
        out.error(`
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
