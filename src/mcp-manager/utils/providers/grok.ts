import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stripMeta } from "@app/mcp-manager/utils/config.utils.js";
import { expandHarnessHome, resolveHarnessHomes } from "@app/mcp-manager/utils/harnesses.js";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import * as TOML from "@iarna/toml";
import chalk from "chalk";
import type { GrokGenericConfig, GrokMCPServerConfig } from "./grok.types.js";
import {
    claudeEnabledPluginServers,
    type DeclaredPluginServer,
    readClaudeSettings,
    readJsonFileIfExists,
    readPluginMcpServers,
} from "./plugins.js";
import type { MCPServerInfo, UnifiedMCPConfig, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, WriteResult } from "./types.js";

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** A `[plugins].enabled` or `disabled` entry names a plugin by name, by `<name>@<marketplace>` or by `<scope>/<hash>/<name>`. */
function namesPlugin(entries: string[], plugin: string): boolean {
    return entries.some((entry) => entry === plugin || entry.startsWith(`${plugin}@`) || entry.endsWith(`/${plugin}`));
}

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

    /** Folders of Grok's own plugins: `[plugins].paths` and the repos in `installed-plugins/registry.json`. */
    private async grokPluginDirs(config: GrokGenericConfig): Promise<string[]> {
        const plugins = isObject(config.plugins) ? config.plugins : {};
        const dirs = stringList(plugins.paths).map(expandHarnessHome);
        const registryPath = path.join(path.dirname(this.configPath), "installed-plugins", "registry.json");

        try {
            const registry = await readJsonFileIfExists(registryPath);
            const repos = isObject(registry) && isObject(registry.repos) ? Object.values(registry.repos) : [];

            for (const repo of repos.filter(isObject)) {
                if (typeof repo.path !== "string") {
                    continue;
                }

                const subdir = isObject(repo.marketplace) ? repo.marketplace.plugin_subdir : undefined;
                const nested = typeof subdir === "string" ? path.join(repo.path, subdir) : null;
                dirs.push(nested && existsSync(nested) ? nested : repo.path);
            }
        } catch (error) {
            logger.warn({ error, registryPath }, "mcp-manager: could not read the Grok plugin registry");
        }

        return dirs;
    }

    /**
     * MCP servers that plugins bring into Grok. Two sources: the plugins Claude's user settings enable
     * (Grok's Claude compatibility; see `claudeEnabledPluginServers`), and Grok's own plugins that
     * `[plugins].enabled` names and `[plugins].disabled` does not.
     */
    private async discoverPluginServers(config: GrokGenericConfig): Promise<DeclaredPluginServer[]> {
        const found: DeclaredPluginServer[] = [];
        const claudeDir = path.join(env.paths.getHome() || env.paths.getUserProfile() || "~", ".claude");

        try {
            found.push(...(await claudeEnabledPluginServers(claudeDir, await readClaudeSettings(claudeDir))));
        } catch (error) {
            logger.warn({ error, claudeDir }, "mcp-manager: could not read the Claude plugins Grok loads");
        }

        const plugins = isObject(config.plugins) ? config.plugins : {};
        const enabled = stringList(plugins.enabled);
        const disabled = stringList(plugins.disabled);

        for (const dir of await this.grokPluginDirs(config)) {
            const manifestPath = [".grok-plugin", ".claude-plugin"]
                .map((folder) => path.join(dir, folder, "plugin.json"))
                .find((candidate) => existsSync(candidate));

            try {
                const manifest = manifestPath ? await readJsonFileIfExists(manifestPath) : undefined;
                const plugin =
                    isObject(manifest) && typeof manifest.name === "string" ? manifest.name : path.basename(dir);

                if (!namesPlugin(enabled, plugin) || namesPlugin(disabled, plugin)) {
                    continue;
                }

                const declared = await readPluginMcpServers(
                    dir,
                    manifestPath ?? path.join(dir, ".grok-plugin", "plugin.json")
                );

                for (const server of declared) {
                    found.push({ ...server, pluginId: plugin, plugin });
                }
            } catch (error) {
                logger.warn({ error, dir }, "mcp-manager: could not read a Grok plugin's MCP servers");
            }
        }

        return found;
    }

    async listPluginServers(): Promise<MCPServerInfo[]> {
        let config: GrokGenericConfig;

        try {
            config = await this.readConfig();
        } catch (error) {
            logger.warn({ error, configPath: this.configPath }, "mcp-manager: could not read Grok config");
            return [];
        }

        const disabled = stringList(config.disabled_mcp_servers);

        return (await this.discoverPluginServers(config)).map((server) => ({
            name: server.name,
            config: server.config,
            enabled: !disabled.includes(server.name) && config.mcp_servers?.[server.name]?.enabled !== false,
            provider: this.providerName,
            plugin: server.pluginId,
        }));
    }

    /**
     * Grok's switch for a plugin server is the top-level `disabled_mcp_servers` list: it stops a
     * name even when no `[mcp_servers]` table defines it (verified on Grok 1.0.44, whose resolved
     * disabled list held `chrome-devtools`, a name that exists only in that list and in a plugin).
     * Enable removes exactly those names, and the key when it ends up empty. Never write a
     * `[mcp_servers.<server>]` table for this.
     */
    async setPluginServersEnabled(serverNames: string[], enabled: boolean): Promise<WriteResult> {
        const config = await this.readConfig();
        const names = new Set(
            (await this.discoverPluginServers(config))
                .map((server) => server.name)
                .filter((name) => serverNames.includes(name))
        );

        if (names.size === 0) {
            return WriteResult.NoChanges;
        }

        const current = stringList(config.disabled_mcp_servers);

        if (enabled) {
            const kept = current.filter((name) => !names.has(name));

            if (kept.length === current.length) {
                return WriteResult.NoChanges;
            }

            if (kept.length === 0) {
                delete config.disabled_mcp_servers;
            } else {
                config.disabled_mcp_servers = kept;
            }
        } else {
            const missing = [...names].filter((name) => !current.includes(name));

            if (missing.length === 0) {
                return WriteResult.NoChanges;
            }

            config.disabled_mcp_servers = [...current, ...missing];
        }

        logger.debug(
            { configPath: this.configPath, names: [...names], enabled },
            "mcp-manager: Grok plugin MCP switch"
        );
        return this.writeConfig(config);
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
        // Read first, then replace ONLY mcp_servers. fromUnifiedConfig builds a fresh
        // object, so writing its result straight out drops every other top-level key:
        // disabled_mcp_servers, [features], [telemetry], [skills], [plugins] and
        // [toolset.*] are lost outright, while [cli], [models], [ui], [marketplace] and
        // [privacy] come back as DEFAULTS on the next grok start, which is why the loss
        // reads as a settings reset rather than a deletion. It destroyed a live
        // ~/.grok/config.toml on 2026-09-10 (diff: -428 +333 lines). Every other writer
        // in this class already reads before it writes; this was the one that did not.
        const config = await this.readConfig();
        const synced = this.fromUnifiedConfig(servers) as GrokGenericConfig;
        config.mcp_servers = synced.mcp_servers ?? {};

        return this.writeConfig(config);
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
