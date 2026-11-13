import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stripMeta } from "@app/mcp-manager/utils/config.utils.js";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { GeminiGenericConfig, GeminiMCPServerConfig } from "./gemini.types.js";
import type { MCPServerInfo, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, type WriteResult } from "./types.js";

/**
 * Gemini Code Assist MCP provider.
 * Manages MCP servers in ~/.gemini/settings.json
 */

export class GeminiProvider extends MCPProvider {
    constructor() {
        const homeDir = env.paths.getHome() || env.paths.getUserProfile() || "~";
        super(path.join(homeDir, ".gemini", "settings.json"), "gemini");
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    async readConfig(): Promise<GeminiGenericConfig> {
        if (!(await this.configExists())) {
            return { mcpServers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return SafeJSON.parse(content) as GeminiGenericConfig;
    }

    private update(change: (config: GeminiGenericConfig) => GeminiGenericConfig | null): Promise<WriteResult> {
        return this.writeCycle({
            read: () => this.readConfig(),
            change,
            serialize: (next) => SafeJSON.stringify(next, { strict: true }, 2),
            path: this.configPath,
            describe: "Gemini MCP servers",
        });
    }

    async listServers(): Promise<MCPServerInfo[]> {
        const config = await this.readConfig();
        const servers: MCPServerInfo[] = [];

        if (config.mcpServers) {
            const excluded = new Set(config.mcp?.excluded || []);
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                const isDisabled = excluded.has(name);
                servers.push({
                    name,
                    config: this.geminiToUnified(serverConfig),
                    enabled: !isDisabled,
                    provider: this.providerName,
                });
            }
        }

        return servers;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        const config = await this.readConfig();
        const serverConfig = config.mcpServers?.[serverName];
        return serverConfig ? this.geminiToUnified(serverConfig) : null;
    }

    async enableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        return this.update((config) => {
            if (config.mcp?.excluded) {
                config.mcp.excluded = config.mcp.excluded.filter((name) => !serverNames.includes(name));
            }

            return config;
        });
    }

    async disableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        return this.update((config) => {
            if (!config.mcp) {
                config.mcp = {};
            }
            if (!config.mcp.excluded) {
                config.mcp.excluded = [];
            }
            for (const serverName of serverNames) {
                if (!config.mcp.excluded.includes(serverName)) {
                    config.mcp.excluded.push(serverName);
                }
            }

            return config;
        });
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult> {
        // Strip _meta before processing (unified utility ensures _meta never reaches providers)
        const cleanConfig = stripMeta(config);

        return this.update((geminiConfig) => {
            if (!geminiConfig.mcpServers) {
                geminiConfig.mcpServers = {};
            }

            geminiConfig.mcpServers[serverName] = this.unifiedToGemini(cleanConfig);

            // Ensure it's enabled by removing from excluded list
            if (geminiConfig.mcp?.excluded) {
                geminiConfig.mcp.excluded = geminiConfig.mcp.excluded.filter((name) => name !== serverName);
            }

            return geminiConfig;
        });
    }

    async removeServers(serverNames: string[]): Promise<WriteResult> {
        return this.update((config) => {
            let changed = false;

            for (const serverName of serverNames) {
                if (config.mcpServers?.[serverName]) {
                    delete config.mcpServers[serverName];
                    changed = true;
                }
                if (config.mcp?.excluded) {
                    const filtered = config.mcp.excluded.filter((name) => name !== serverName);

                    if (filtered.length !== config.mcp.excluded.length) {
                        config.mcp.excluded = filtered;
                        changed = true;
                    }
                }
            }

            return changed ? config : null;
        });
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        return this.update((config) => {
            if (!config.mcpServers) {
                config.mcpServers = {};
            }
            if (!config.mcp) {
                config.mcp = {};
            }
            if (!config.mcp.excluded) {
                config.mcp.excluded = [];
            }

            for (const [name, serverConfig] of Object.entries(servers)) {
                const isEnabled = this.isServerEnabledInMeta(serverConfig);
                config.mcpServers[name] = this.unifiedToGemini(stripMeta(serverConfig));

                if (isEnabled) {
                    config.mcp.excluded = config.mcp.excluded.filter((n) => n !== name);
                } else if (!config.mcp.excluded.includes(name)) {
                    config.mcp.excluded.push(name);
                }
            }

            return config;
        });
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const geminiConfig = config as GeminiGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (geminiConfig.mcpServers) {
            for (const [name, serverConfig] of Object.entries(geminiConfig.mcpServers)) {
                // Strip _meta if it somehow got into provider config (shouldn't happen, but safety check)
                result[name] = stripMeta(this.geminiToUnified(serverConfig));
            }
        }

        return result;
    }

    /**
     * Check if a server is enabled in this provider's config
     */
    async isServerEnabled(serverName: string): Promise<boolean> {
        const config = await this.readConfig();
        const excluded = new Set(config.mcp?.excluded || []);
        return !excluded.has(serverName);
    }

    private geminiToUnified(gemini: GeminiMCPServerConfig): UnifiedMCPServerConfig {
        let type: "stdio" | "sse" | "http" = "stdio";
        if (gemini.url) {
            type = "sse";
        } else if (gemini.httpUrl) {
            type = "http";
        }

        return {
            type,
            command: gemini.command,
            args: gemini.args,
            env: gemini.env,
            url: gemini.url as string | undefined,
            httpUrl: gemini.httpUrl as string | undefined,
            headers: gemini.headers as Record<string, string> | undefined,
        };
    }

    private unifiedToGemini(unified: UnifiedMCPServerConfig): GeminiMCPServerConfig {
        return {
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url as string | undefined,
            httpUrl: unified.httpUrl as string | undefined,
            headers: unified.headers as Record<string, string> | undefined,
        };
    }
}
