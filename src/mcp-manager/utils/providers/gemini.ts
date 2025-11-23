import { MCPProvider } from "./types.js";
import type { UnifiedMCPServerConfig, MCPServerInfo } from "./types.js";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import logger from "@app/logger";
import chalk from "chalk";

/**
 * Gemini Code Assist MCP provider.
 * Manages MCP servers in ~/.gemini/settings.json
 */
interface GeminiGenericConfig {
    mcp?: {
        excluded?: string[];
        [key: string]: unknown;
    };
    mcpServers?: Record<string, GeminiMCPServerConfig>;
    [key: string]: unknown;
}

interface GeminiMCPServerConfig {
    disabled?: boolean;
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;
    httpUrl?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
}

export class GeminiProvider extends MCPProvider {
    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
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
        return JSON.parse(content) as GeminiGenericConfig;
    }

    async writeConfig(config: unknown): Promise<void> {
        // Read old content for backup and diff
        let oldContent = "";
        let backupPath = "";
        if (await this.configExists()) {
            oldContent = await readFile(this.configPath, "utf-8");
            // Create backup
            backupPath = await this.backupManager.createBackup(this.configPath, this.providerName);
            if (backupPath) {
                logger.info(`Backup created: ${backupPath}`);
            }
        }

        const newContent = JSON.stringify(config, null, 2);

        // Show diff if there are changes and ask for confirmation
        if (oldContent) {
            this.backupManager.showDiff(oldContent, newContent, this.configPath);
            const confirmed = await this.backupManager.askConfirmation();

            if (!confirmed) {
                // Restore from backup if user rejected changes
                if (backupPath) {
                    await this.backupManager.restoreFromBackup(this.configPath, backupPath);
                }
                logger.info(chalk.yellow("Changes reverted."));
                return;
            }
        }

        await writeFile(this.configPath, newContent, "utf-8");
        logger.info(chalk.green(`✓ Configuration written to ${this.configPath}`));
    }

    async listServers(): Promise<MCPServerInfo[]> {
        const config = await this.readConfig();
        const servers: MCPServerInfo[] = [];

        if (config.mcpServers) {
            const excluded = new Set(config.mcp?.excluded || []);
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                const isDisabled = serverConfig.disabled === true || excluded.has(name);
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

    async enableServer(serverName: string): Promise<void> {
        const config = await this.readConfig();

        // Remove from excluded list
        if (config.mcp?.excluded) {
            config.mcp.excluded = config.mcp.excluded.filter((name) => name !== serverName);
        }

        // Set disabled to false in server config
        if (config.mcpServers?.[serverName]) {
            config.mcpServers[serverName].disabled = false;
        }

        await this.writeConfig(config);
    }

    async disableServer(serverName: string): Promise<void> {
        const config = await this.readConfig();

        // Set disabled to true in server config
        if (!config.mcpServers) {
            config.mcpServers = {};
        }
        if (!config.mcpServers[serverName]) {
            config.mcpServers[serverName] = {};
        }
        config.mcpServers[serverName].disabled = true;

        await this.writeConfig(config);
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        // Gemini doesn't have project-specific configs, so same as disableServer
        await this.disableServer(serverName);
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void> {
        const geminiConfig = await this.readConfig();

        if (!geminiConfig.mcpServers) {
            geminiConfig.mcpServers = {};
        }

        geminiConfig.mcpServers[serverName] = this.unifiedToGemini(config);

        // Ensure it's enabled
        await this.enableServer(serverName);

        await this.writeConfig(geminiConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void> {
        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        // Add/update all servers
        for (const [name, serverConfig] of Object.entries(servers)) {
            config.mcpServers[name] = this.unifiedToGemini(serverConfig);
        }

        // Update excluded list
        if (!config.mcp) {
            config.mcp = {};
        }
        config.mcp.excluded = Object.entries(servers)
            .filter(([_, unified]) => unified.disabled === true || unified.enabled === false)
            .map(([name]) => name);

        await this.writeConfig(config);
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const geminiConfig = config as GeminiGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (geminiConfig.mcpServers) {
            const excluded = new Set(geminiConfig.mcp?.excluded || []);
            for (const [name, serverConfig] of Object.entries(geminiConfig.mcpServers)) {
                const isDisabled = serverConfig.disabled === true || excluded.has(name);
                result[name] = {
                    ...this.geminiToUnified(serverConfig),
                    enabled: !isDisabled,
                };
            }
        }

        return result;
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: GeminiGenericConfig = {
            mcp: { excluded: [] },
            mcpServers: {},
        };

        for (const [name, unified] of Object.entries(servers)) {
            config.mcpServers![name] = this.unifiedToGemini(unified);
            if (unified.disabled === true || unified.enabled === false) {
                config.mcp!.excluded!.push(name);
            }
        }

        return config;
    }

    private geminiToUnified(gemini: GeminiMCPServerConfig): UnifiedMCPServerConfig {
        return {
            type: gemini.httpUrl ? "http" : "stdio",
            command: gemini.command,
            args: gemini.args,
            env: gemini.env,
            httpUrl: gemini.httpUrl,
            headers: gemini.headers,
            disabled: gemini.disabled,
        };
    }

    private unifiedToGemini(unified: UnifiedMCPServerConfig): GeminiMCPServerConfig {
        return {
            command: unified.command,
            args: unified.args,
            env: unified.env,
            httpUrl: unified.httpUrl,
            headers: unified.headers,
            disabled: unified.disabled === true || unified.enabled === false,
        };
    }
}
