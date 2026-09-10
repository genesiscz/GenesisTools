import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stripMeta } from "@app/mcp-manager/utils/config.utils.js";
import { expandHarnessHome, resolveHarnessHomes } from "@app/mcp-manager/utils/harnesses.js";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import * as TOML from "@iarna/toml";
import chalk from "chalk";
import type { GrokGenericConfig, GrokMCPServerConfig } from "./grok.types.js";
import type { MCPServerInfo, UnifiedMCPConfig, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, WriteResult } from "./types.js";

function grokConfigPathForHome(home: string): string {
    const expanded = expandHarnessHome(home);

    if (expanded.endsWith("config.toml")) {
        return expanded;
    }

    return path.join(expanded, "config.toml");
}

export class GrokProvider extends MCPProvider {
    constructor() {
        const home = path.join(env.paths.getHome() || env.paths.getUserProfile() || "~", ".grok");
        super(grokConfigPathForHome(home), "grok");
    }

    applyHarnessConfig(config: UnifiedMCPConfig): void {
        const homes = resolveHarnessHomes(config, "grok", "syncTo");
        const primary = homes[0];

        if (primary) {
            this.configPath = grokConfigPathForHome(primary);
        }
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    supportsDisabledState(): boolean {
        return true;
    }

    async readConfig(): Promise<GrokGenericConfig> {
        if (!(await this.configExists())) {
            return { mcp_servers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");

        return TOML.parse(content) as GrokGenericConfig;
    }

    async writeConfig(config: unknown): Promise<WriteResult> {
        const dir = path.dirname(this.configPath);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const newContent = TOML.stringify(config as TOML.JsonMap);
        const oldContent = (await this.configExists()) ? await readFile(this.configPath, "utf-8") : "";

        if (oldContent === newContent) {
            return WriteResult.NoChanges;
        }

        await this.backupManager.showDiff(oldContent, newContent, this.configPath);
        const confirmed = await this.backupManager.askConfirmation();

        if (!confirmed) {
            return WriteResult.Rejected;
        }

        await this.writeFileWithBackup(newContent);
        logger.info(chalk.green(`✓ Configuration written to ${this.configPath}`));

        return WriteResult.Applied;
    }

    async listServers(): Promise<MCPServerInfo[]> {
        const config = await this.readConfig();
        const servers: MCPServerInfo[] = [];

        for (const [name, serverConfig] of Object.entries(config.mcp_servers ?? {})) {
            servers.push({
                name,
                config: this.grokToUnified(serverConfig),
                enabled: serverConfig.enabled !== false,
                provider: this.providerName,
            });
        }

        return servers;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        const server = (await this.readConfig()).mcp_servers?.[serverName];

        return server ? this.grokToUnified(server) : null;
    }

    async enableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();
        const server = config.mcp_servers?.[serverName];

        if (!server) {
            throw new Error(`Server ${serverName} does not exist. Use installServer to add it.`);
        }

        server.enabled = true;
        await this.writeConfig(config);
    }

    async disableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();
        const server = config.mcp_servers?.[serverName];

        if (!server) {
            return;
        }

        server.enabled = false;
        await this.writeConfig(config);
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        await this.disableServer(serverName);
    }

    async enableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        for (const name of serverNames) {
            if (!config.mcp_servers?.[name]) {
                throw new Error(`Servers do not exist: ${name}. Use installServer to add them.`);
            }

            config.mcp_servers[name].enabled = true;
        }

        return this.writeConfig(config);
    }

    async disableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        for (const name of serverNames) {
            if (config.mcp_servers?.[name]) {
                config.mcp_servers[name].enabled = false;
            }
        }

        return this.writeConfig(config);
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult> {
        const grokConfig = await this.readConfig();

        if (!grokConfig.mcp_servers) {
            grokConfig.mcp_servers = {};
        }

        grokConfig.mcp_servers[serverName] = this.unifiedToGrok(stripMeta(config));

        return this.writeConfig(grokConfig);
    }

    async removeServers(serverNames: string[]): Promise<WriteResult> {
        const config = await this.readConfig();
        let changed = false;

        for (const name of serverNames) {
            if (config.mcp_servers?.[name]) {
                delete config.mcp_servers[name];
                changed = true;
            }
        }

        if (!changed) {
            return WriteResult.NoChanges;
        }

        return this.writeConfig(config);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        return this.writeConfig(this.fromUnifiedConfig(servers));
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const grokConfig = config as GrokGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        for (const [name, serverConfig] of Object.entries(grokConfig.mcp_servers ?? {})) {
            result[name] = stripMeta(this.grokToUnified(serverConfig));
        }

        return result;
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: GrokGenericConfig = { mcp_servers: {} };

        for (const [name, unified] of Object.entries(servers)) {
            const enabled = this.isServerEnabledInMeta(unified);
            const converted = this.unifiedToGrok(stripMeta(unified));
            converted.enabled = enabled;
            config.mcp_servers![name] = converted;
        }

        return config;
    }

    private grokToUnified(grok: GrokMCPServerConfig): UnifiedMCPServerConfig {
        let type: "stdio" | "sse" | "http" = "stdio";

        if (grok.url && !grok.command) {
            type = "http";
        }

        return {
            type,
            command: grok.command,
            args: grok.args,
            env: grok.env,
            url: grok.url,
            headers: grok.headers,
        };
    }

    private unifiedToGrok(unified: UnifiedMCPServerConfig): GrokMCPServerConfig {
        return {
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url,
            headers: unified.headers,
        };
    }
}
