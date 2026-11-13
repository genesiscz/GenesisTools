import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stripMeta } from "@app/mcp-manager/utils/config.utils.js";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { CursorGenericConfig, CursorMCPServerConfig } from "./cursor.types.js";
import { deletePresent, enablePresent } from "./presence.js";
import type { MCPServerInfo, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, type WriteResult } from "./types.js";

/**
 * Cursor MCP provider.
 * Manages MCP servers in workspace-specific storage.
 * Note: Cursor uses workspace storage, so this is a simplified implementation.
 */

export class CursorProvider extends MCPProvider {
    constructor() {
        // Cursor uses workspace storage, but we'll use a global config location
        // In practice, this might need to be workspace-specific
        const homeDir = env.paths.getHome() || env.paths.getUserProfile() || "~";
        super(path.join(homeDir, ".cursor", "mcp.json"), "cursor");
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    /** Presence means enabled: `sync` installs only the servers the unified config enables here. */
    shouldBeInstalled(serverConfig: UnifiedMCPServerConfig): boolean {
        return this.isServerEnabledInMeta(serverConfig);
    }

    async readConfig(): Promise<CursorGenericConfig> {
        if (!(await this.configExists())) {
            return { mcpServers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return SafeJSON.parse(content) as CursorGenericConfig;
    }

    private update(change: (config: CursorGenericConfig) => CursorGenericConfig | null): Promise<WriteResult> {
        return this.writeCycle({
            read: () => this.readConfig(),
            change,
            serialize: (next) => SafeJSON.stringify(next, { strict: true }, 2),
            path: this.configPath,
            describe: "Cursor MCP servers",
        });
    }

    async listServers(): Promise<MCPServerInfo[]> {
        const config = await this.readConfig();
        const servers: MCPServerInfo[] = [];

        // Cursor doesn't have explicit enable/disable, so all servers are enabled
        if (config.mcpServers) {
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                servers.push({
                    name,
                    config: this.cursorToUnified(serverConfig),
                    enabled: true,
                    provider: this.providerName,
                });
            }
        }

        return servers;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        const config = await this.readConfig();
        const serverConfig = config.mcpServers?.[serverName];
        return serverConfig ? this.cursorToUnified(serverConfig) : null;
    }

    async enableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        return enablePresent((await this.readConfig()).mcpServers, serverNames);
    }

    async disableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        return this.removeServers(serverNames);
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult> {
        // Strip _meta before processing (unified utility ensures _meta never reaches providers)
        const cleanConfig = stripMeta(config);

        return this.update((cursorConfig) => {
            if (!cursorConfig.mcpServers) {
                cursorConfig.mcpServers = {};
            }

            cursorConfig.mcpServers[serverName] = this.unifiedToCursor(cleanConfig);
            return cursorConfig;
        });
    }

    async removeServers(serverNames: string[]): Promise<WriteResult> {
        return this.update((config) => (deletePresent(config.mcpServers, serverNames) ? config : null));
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        return this.update((config) => {
            if (!config.mcpServers) {
                config.mcpServers = {};
            }

            for (const [name, serverConfig] of Object.entries(servers)) {
                if (this.isServerEnabledInMeta(serverConfig)) {
                    config.mcpServers[name] = this.unifiedToCursor(stripMeta(serverConfig));
                } else {
                    delete config.mcpServers[name];
                }
            }

            return config;
        });
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const cursorConfig = config as CursorGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (cursorConfig.mcpServers) {
            for (const [name, serverConfig] of Object.entries(cursorConfig.mcpServers)) {
                // Strip _meta if it somehow got into provider config (shouldn't happen, but safety check)
                result[name] = stripMeta(this.cursorToUnified(serverConfig));
            }
        }

        return result;
    }

    private cursorToUnified(cursor: CursorMCPServerConfig): UnifiedMCPServerConfig {
        let type: "stdio" | "sse" | "http" = (cursor.type as "stdio" | "sse" | "http") || "stdio";
        if (cursor.url && !cursor.command) {
            type = "sse";
        }

        return {
            type,
            command: cursor.command,
            args: cursor.args,
            env: cursor.env,
            url: cursor.url as string | undefined,
            headers: cursor.headers as Record<string, string> | undefined,
        };
    }

    private unifiedToCursor(unified: UnifiedMCPServerConfig): CursorMCPServerConfig {
        return {
            type: unified.type || "stdio",
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url,
            headers: unified.headers,
        };
    }
}
