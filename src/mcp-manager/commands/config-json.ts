import clipboardy from "clipboardy";
import logger from "@app/logger";
import { readUnifiedConfig, stripMetaFromServers } from "../utils/config.utils.js";
import type { UnifiedMCPServerConfig } from "../utils/providers/types.js";

export interface ConfigJsonOptions {
    client?: "standard" | "cursor" | "claude";
    enabledOnly?: boolean;
    servers?: string;
    bare?: boolean;
    clipboard?: boolean;
}

type ClientType = "standard" | "cursor" | "claude";

/**
 * Check if a server is enabled for a specific client based on _meta.enabled
 */
function isServerEnabledForClient(
    serverConfig: UnifiedMCPServerConfig,
    client: ClientType
): boolean {
    const enabledState = serverConfig._meta?.enabled;
    if (!enabledState) {
        return false;
    }

    const clientState = enabledState[client as keyof typeof enabledState];
    if (clientState === undefined) {
        return false;
    }

    if (typeof clientState === "boolean") {
        return clientState;
    }

    // Per-project state - consider enabled if any project has it enabled
    return Object.values(clientState).some((v) => v === true);
}

/**
 * Get list of disabled servers for a specific client
 */
function getDisabledServers(
    servers: Record<string, UnifiedMCPServerConfig>,
    client: ClientType
): string[] {
    const disabled: string[] = [];
    for (const [name, config] of Object.entries(servers)) {
        if (!isServerEnabledForClient(config, client)) {
            disabled.push(name);
        }
    }
    return disabled;
}

/**
 * Output MCP server configurations in standard JSON format
 */
export async function configJson(options: ConfigJsonOptions = {}): Promise<void> {
    const client: ClientType = options.client || "standard";
    const enabledOnly = options.enabledOnly || false;
    const serverFilter = options.servers?.split(",").map((s) => s.trim()).filter(Boolean);
    const bare = options.bare || false;
    const copyToClipboard = options.clipboard || false;

    // Read unified config
    const config = await readUnifiedConfig();
    let servers = config.mcpServers;

    // Filter by server names if specified
    if (serverFilter && serverFilter.length > 0) {
        const filtered: Record<string, UnifiedMCPServerConfig> = {};
        for (const name of serverFilter) {
            if (servers[name]) {
                filtered[name] = servers[name];
            } else {
                logger.warn(`Server '${name}' not found in config`);
            }
        }
        servers = filtered;
    }

    // Filter to enabled-only if requested
    if (enabledOnly) {
        const filtered: Record<string, UnifiedMCPServerConfig> = {};
        for (const [name, serverConfig] of Object.entries(servers)) {
            if (isServerEnabledForClient(serverConfig, client)) {
                filtered[name] = serverConfig;
            }
        }
        servers = filtered;
    }

    // Strip _meta from all server configs
    const strippedServers = stripMetaFromServers(servers);

    // Build output based on client type
    let output: unknown;

    if (client === "claude") {
        // Claude format includes disabledMcpServers
        const disabledServers = getDisabledServers(config.mcpServers, "claude");
        // Only include disabled servers that are actually in our output
        const relevantDisabled = disabledServers.filter((name) => name in strippedServers);

        if (bare) {
            output = strippedServers;
        } else {
            output = {
                mcpServers: strippedServers,
                ...(relevantDisabled.length > 0 && { disabledMcpServers: relevantDisabled }),
            };
        }
    } else {
        // Standard/Cursor format - just mcpServers
        if (bare) {
            output = strippedServers;
        } else {
            output = { mcpServers: strippedServers };
        }
    }

    const jsonOutput = JSON.stringify(output, null, 2);

    if (copyToClipboard) {
        await clipboardy.write(jsonOutput);
        logger.info("✔ Configuration copied to clipboard");
    } else {
        console.log(jsonOutput);
    }
}
