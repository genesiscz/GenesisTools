import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stripMeta } from "@app/mcp-manager/utils/config.utils.js";
import {
    codexConfigPathForHome,
    codexHomeDir,
    mergeCodexServersForHome,
    resolveHarnessHomes,
} from "@app/mcp-manager/utils/harnesses.js";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import * as TOML from "@iarna/toml";
import chalk from "chalk";
import type { CodexGenericConfig, CodexMCPServerConfig } from "./codex.types.js";
import type { MCPServerInfo, UnifiedMCPConfig, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, WriteResult } from "./types.js";

export interface CodexProviderOptions {
    syncToHomes?: string[];
    syncFromHomes?: string[];
}

/**
 * Codex MCP provider.
 * Manages MCP servers in each configured Codex home's config.toml
 */

export class CodexProvider extends MCPProvider {
    private syncToHomes: string[];
    private syncFromHomes: string[];

    constructor(options: CodexProviderOptions = {}) {
        const defaultHome = path.join(env.paths.getHome() || env.paths.getUserProfile() || "~", ".codex");
        const syncToHomes = options.syncToHomes?.length ? options.syncToHomes : [defaultHome];
        super(codexConfigPathForHome(syncToHomes[0] ?? defaultHome), "codex");
        this.syncToHomes = syncToHomes;
        this.syncFromHomes = options.syncFromHomes?.length ? options.syncFromHomes : [...syncToHomes];
    }

    applyHarnessConfig(config: UnifiedMCPConfig): void {
        this.syncToHomes = resolveHarnessHomes(config, "codex", "syncTo");
        this.syncFromHomes = resolveHarnessHomes(config, "codex", "syncFrom");
        const primary = this.syncToHomes[0];

        if (primary) {
            this.configPath = codexConfigPathForHome(primary);
        }
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    supportsDisabledState(): boolean {
        return false; // Codex: presence in config = enabled
    }

    async readConfig(): Promise<CodexGenericConfig> {
        return this.readConfigAt(this.configPath);
    }

    private async readConfigAt(configPath: string): Promise<CodexGenericConfig> {
        if (!existsSync(configPath)) {
            return { mcp_servers: {} };
        }

        const content = await readFile(configPath, "utf-8");
        return TOML.parse(content) as CodexGenericConfig;
    }

    /**
     * Reads answer from every configured `syncFrom` home, first home wins on a name
     * clash. Writes stay on `this.configPath` (the primary `syncTo` home) — reading a
     * shop home must never make the next install land there.
     */
    private syncFromConfigPaths(): string[] {
        const homes = this.syncFromHomes.length > 0 ? this.syncFromHomes : [codexHomeDir(this.configPath)];
        return homes.map(codexConfigPathForHome);
    }

    async writeConfig(config: unknown): Promise<WriteResult> {
        // Ensure directory exists
        const dir = path.dirname(this.configPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const newContent = TOML.stringify(config as TOML.JsonMap);

        // Read old content (empty string if file doesn't exist)
        const oldContent = (await this.configExists()) ? await readFile(this.configPath, "utf-8") : "";

        // Early exit if no changes
        if (oldContent === newContent) {
            return WriteResult.NoChanges;
        }

        // Show diff and ask for confirmation
        await this.backupManager.showDiff(oldContent, newContent, this.configPath);
        const confirmed = await this.backupManager.askConfirmation();

        if (!confirmed) {
            return WriteResult.Rejected;
        }

        // Only now write to file (with backup)
        await this.writeFileWithBackup(newContent);
        logger.info(chalk.green(`✓ Configuration written to ${this.configPath}`));
        return WriteResult.Applied;
    }

    async listServers(): Promise<MCPServerInfo[]> {
        const servers: MCPServerInfo[] = [];
        const seen = new Set<string>();

        for (const configPath of this.syncFromConfigPaths()) {
            const config = await this.readConfigAt(configPath);

            // Codex doesn't have explicit enable/disable, so all servers are enabled
            for (const [name, serverConfig] of Object.entries(config.mcp_servers ?? {})) {
                if (seen.has(name)) {
                    continue;
                }

                seen.add(name);
                servers.push({
                    name,
                    config: this.codexToUnified(serverConfig),
                    enabled: true,
                    provider: this.providerName,
                });
            }
        }

        return servers;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        for (const configPath of this.syncFromConfigPaths()) {
            const serverConfig = (await this.readConfigAt(configPath)).mcp_servers?.[serverName];

            if (serverConfig) {
                return this.codexToUnified(serverConfig);
            }
        }

        return null;
    }

    async enableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        // Codex doesn't have explicit enable/disable
        // Servers are enabled if they exist in config
        // This is a no-op, but we ensure the server exists
        const config = await this.readConfig();
        if (!config.mcp_servers?.[serverName]) {
            throw new Error(`Server ${serverName} does not exist. Use installServer to add it.`);
        }
    }

    async disableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        // Remove the server from config (Codex doesn't have explicit disable)
        if (config.mcp_servers?.[serverName]) {
            delete config.mcp_servers[serverName];
            const result = await this.writeConfig(config);
            if (result === WriteResult.Rejected) {
                throw new Error(`Write rejected by user for server ${serverName}`);
            }
        }
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        // Same as disableServer for Codex
        await this.disableServer(serverName);
    }

    async enableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        // Codex doesn't have explicit enable/disable
        // Servers are enabled if they exist in config - this is a no-op
        const config = await this.readConfig();
        const missing = serverNames.filter((name) => !config.mcp_servers?.[name]);
        if (missing.length > 0) {
            throw new Error(`Servers do not exist: ${missing.join(", ")}. Use installServer to add them.`);
        }
        return WriteResult.NoChanges;
    }

    async disableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        let changed = false;
        for (const serverName of serverNames) {
            if (config.mcp_servers?.[serverName]) {
                delete config.mcp_servers[serverName];
                changed = true;
            }
        }

        if (changed) {
            return this.writeConfig(config);
        }
        return WriteResult.NoChanges;
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult> {
        // Strip _meta before processing (unified utility ensures _meta never reaches providers)
        const cleanConfig = stripMeta(config);
        const codexConfig = await this.readConfig();

        if (!codexConfig.mcp_servers) {
            codexConfig.mcp_servers = {};
        }

        codexConfig.mcp_servers[serverName] = this.unifiedToCodex(cleanConfig);

        return this.writeConfig(codexConfig);
    }

    async removeServers(serverNames: string[]): Promise<WriteResult> {
        const config = await this.readConfig();
        let changed = false;

        for (const serverName of serverNames) {
            if (config.mcp_servers?.[serverName]) {
                // Deleting the parsed key drops the whole [mcp_servers.<name>]
                // section including nested subsections ([...env],
                // [...http_headers]); unrelated content like [projects.*] and
                // [notice] is part of the same parsed object and survives the
                // re-serialization untouched.
                delete config.mcp_servers[serverName];
                changed = true;
            }
        }

        if (!changed) {
            return WriteResult.NoChanges;
        }

        return this.writeConfig(config);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        let applied = false;
        const homes = this.syncToHomes.length > 0 ? this.syncToHomes : [codexHomeDir(this.configPath)];

        for (let i = 0; i < homes.length; i++) {
            const home = homes[i];
            if (!home) {
                continue;
            }

            const configPath = codexConfigPathForHome(home);
            const isPrimary = i === 0;

            if (!isPrimary && !existsSync(configPath)) {
                logger.warn(`Skipping Codex home ${home}: ${configPath} does not exist`);
                continue;
            }

            const result = await this.withConfigPath(configPath, () =>
                this.syncServersAtCurrentPath(servers, {
                    destHome: codexHomeDir(home),
                    allHomes: homes.map(codexHomeDir),
                    // Every home, not only the primary. Codex has no disabled state, so
                    // `listServers` reports whatever survives in ANY syncFrom home as enabled:
                    // leaving a disabled server in an extra home meant the next `sync-from`
                    // read it back as enabled and the following `sync` reinstalled it. The
                    // deletion is keyed by a name the UNIFIED config marks disabled, so a
                    // server only that home knows about is never touched.
                    deleteDisabled: true,
                    protectHomeBound: !isPrimary,
                })
            );

            if (result === WriteResult.Rejected) {
                return result;
            }

            if (result === WriteResult.Applied) {
                applied = true;
            }
        }

        return applied ? WriteResult.Applied : WriteResult.NoChanges;
    }

    private async withConfigPath<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.configPath;
        this.configPath = configPath;

        try {
            return await fn();
        } finally {
            this.configPath = previous;
        }
    }

    private async syncServersAtCurrentPath(
        servers: Record<string, UnifiedMCPServerConfig>,
        opts: {
            destHome: string;
            allHomes: string[];
            deleteDisabled: boolean;
            protectHomeBound: boolean;
        }
    ): Promise<WriteResult> {
        const config = await this.readConfig();

        if (!config.mcp_servers) {
            config.mcp_servers = {};
        }

        const incoming: Record<string, CodexMCPServerConfig> = {};

        for (const [name, serverConfig] of Object.entries(servers)) {
            const isEnabled = this.isServerEnabledInMeta(serverConfig);

            if (isEnabled) {
                incoming[name] = this.unifiedToCodex(stripMeta(serverConfig));
            } else if (opts.deleteDisabled) {
                delete config.mcp_servers[name];
            }
        }

        config.mcp_servers = mergeCodexServersForHome({
            dest: config.mcp_servers,
            incoming,
            destHome: opts.destHome,
            allHomes: opts.allHomes,
            protectHomeBound: opts.protectHomeBound,
        });

        return this.writeConfig(config);
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const codexConfig = config as CodexGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (codexConfig.mcp_servers) {
            for (const [name, serverConfig] of Object.entries(codexConfig.mcp_servers)) {
                // Strip _meta if it somehow got into provider config (shouldn't happen, but safety check)
                result[name] = stripMeta(this.codexToUnified(serverConfig));
            }
        }

        return result;
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: CodexGenericConfig = {
            mcp_servers: {},
        };

        for (const [name, unified] of Object.entries(servers)) {
            // Read enabled state using utility method
            const isEnabled = this.isServerEnabledInMeta(unified);

            // Codex doesn't have native disable - only include if enabled
            if (isEnabled) {
                const cleanConfig = stripMeta(unified);
                config.mcp_servers![name] = this.unifiedToCodex(cleanConfig);
            }
        }

        return config;
    }

    private codexToUnified(codex: CodexMCPServerConfig): UnifiedMCPServerConfig {
        let type: "stdio" | "sse" | "http" = (codex.type as "stdio" | "sse" | "http") || "stdio";
        if (codex.url && !codex.command) {
            type = "sse";
        }

        return {
            type,
            command: codex.command,
            args: codex.args,
            env: codex.env,
            url: codex.url as string | undefined,
            headers: (codex.http_headers ?? codex.headers) as Record<string, string> | undefined,
        };
    }

    private unifiedToCodex(unified: UnifiedMCPServerConfig): CodexMCPServerConfig {
        return {
            type: unified.type || "stdio",
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url,
            http_headers: unified.headers,
        };
    }
}
