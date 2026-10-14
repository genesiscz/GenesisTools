import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readUnifiedConfig, stripMeta, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import type { PerProjectEnabledState } from "@app/mcp-manager/utils/types.js";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { matchGlob } from "@genesiscz/utils/string";
import chalk from "chalk";
import type { ClaudeGenericConfig, ClaudeMCPServerConfig } from "./claude.types.js";
import { claudeEnabledPluginServers, readClaudeSettings } from "./plugins.js";
import type { EnableServersOptions, MCPServerInfo, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, WriteResult } from "./types.js";

interface ClaudePluginServer {
    info: MCPServerInfo;
    /** The name Claude Code registers the server under: `plugin:<plugin>:<server>`. */
    registeredName: string;
}

/** The name Claude Code gives a plugin's MCP server, e.g. `plugin:expo:expo`. */
export function claudePluginServerName(plugin: string, server: string): string {
    return `plugin:${plugin}:${server}`;
}

function deniedEntries(settings: Record<string, unknown>): unknown[] {
    return Array.isArray(settings.deniedMcpServers) ? settings.deniedMcpServers : [];
}

/** True when a `deniedMcpServers` entry names the server, or a `serverUrl` pattern matches its URL. */
function isDeniedByClaude(denied: unknown[], registeredName: string, url: string | undefined): boolean {
    return denied.some((entry) => {
        if (!isObject(entry)) {
            return false;
        }

        if (entry.serverName === registeredName) {
            return true;
        }

        return typeof entry.serverUrl === "string" && url !== undefined && matchGlob(url, entry.serverUrl);
    });
}

/**
 * Claude Desktop MCP provider.
 * Manages MCP servers in ~/.claude.json
 *
 * IMPORTANT (verified against the Claude Code binary): Claude Code reads
 * `disabledMcpServers` ONLY from per-project entries
 * (`.projects[<cwd>].disabledMcpServers`). The TOP-LEVEL `disabledMcpServers`
 * key is NEVER read by Claude Code — it is an mcp-manager-only marker. The only
 * mechanism Claude Code honors globally (including future projects) is the
 * server NOT existing in `mcpServers` — so a TRUE global disable removes the
 * entry (after preserving its full config in the unified config with
 * `_meta.enabled.claude = false`), and a global enable restores it.
 *
 * Global means the global switch only. A global disable, a global enable, an
 * install and a sync of a boolean or unset `_meta.enabled.claude` never write a
 * project's `disabledMcpServers` list: a sync once wanted to add one disabled
 * server to all 98 project lists (about 640 diff lines). Only a named project
 * writes its own list: `enable|disable --project <path>`, or a sync of a
 * per-project `_meta.enabled.claude` map, for exactly the projects it names.
 * The one opt-in exception is `enable --clear-project-overrides`, which takes
 * the name off every project list that still names it.
 */
export class ClaudeProvider extends MCPProvider {
    constructor() {
        const homeDir = env.paths.getHome() || env.paths.getUserProfile() || "~";
        super(path.join(homeDir, ".claude.json"), "claude");
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    supportsDisabledState(): boolean {
        return true; // Claude has disabledMcpServers list
    }

    shouldBeInstalled(serverConfig: UnifiedMCPServerConfig): boolean {
        // A globally-disabled server (_meta.enabled.claude === false) must be
        // ABSENT from ~/.claude.json — absence is the only global disable
        // Claude Code honors. Everything else (enabled, per-project, unset)
        // stays installed.
        return serverConfig._meta?.enabled?.claude !== false;
    }

    async readConfig(): Promise<ClaudeGenericConfig> {
        if (!(await this.configExists())) {
            return { mcpServers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return SafeJSON.parse(content) as ClaudeGenericConfig;
    }

    async writeConfig(config: unknown): Promise<WriteResult> {
        const newContent = SafeJSON.stringify(config, { strict: true }, 2);

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
        const config = await this.readConfig();
        const servers: MCPServerInfo[] = [];
        const globalNames = new Set<string>();

        // Global servers
        if (config.mcpServers) {
            const disabledServers = new Set(config.disabledMcpServers || []);
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                globalNames.add(name);
                servers.push({
                    name,
                    config: this.claudeToUnified(serverConfig),
                    enabled: !disabledServers.has(name),
                    provider: this.providerName,
                });
            }
        }

        // Project-scope servers (this is where per-project overrides of
        // globally-disabled servers live — one row per project so callers can
        // see/count every override).
        if (config.projects) {
            for (const [projectPath, projectConfig] of Object.entries(config.projects)) {
                if (projectConfig.mcpServers) {
                    const projectDisabled = new Set(projectConfig.disabledMcpServers || []);
                    for (const [name, serverConfig] of Object.entries(projectConfig.mcpServers)) {
                        // Only add if not already in global list
                        if (!globalNames.has(name)) {
                            servers.push({
                                name,
                                config: this.claudeToUnified(serverConfig),
                                enabled: !projectDisabled.has(name),
                                provider: `${this.providerName}:${projectPath}`,
                            });
                        }
                    }
                }
            }
        }

        // Globally-disabled servers are absent from ~/.claude.json entirely
        // (absence is the only global disable Claude Code honors). Surface them
        // from the unified config as disabled so they don't look "not installed".
        const unified = await readUnifiedConfig();
        for (const [name, entry] of Object.entries(unified.mcpServers)) {
            if (entry._meta?.enabled?.claude !== false) {
                continue;
            }
            if (globalNames.has(name)) {
                continue;
            }
            servers.push({
                name,
                config: stripMeta(entry),
                enabled: false,
                provider: this.providerName,
            });
        }

        return servers;
    }

    /** `~/.claude/settings.json`: user settings, home of `enabledPlugins` and the `deniedMcpServers` denylist. */
    getSettingsPath(): string {
        return path.join(path.dirname(this.configPath), ".claude", "settings.json");
    }

    private async readSettings(): Promise<Record<string, unknown>> {
        return readClaudeSettings(path.dirname(this.getSettingsPath()));
    }

    private async discoverPluginServers(settings: Record<string, unknown>): Promise<ClaudePluginServer[]> {
        const denied = deniedEntries(settings);
        const declared = await claudeEnabledPluginServers(path.dirname(this.getSettingsPath()), settings);

        return declared.map((server) => {
            const registeredName = claudePluginServerName(server.plugin, server.name);

            return {
                registeredName,
                info: {
                    name: server.name,
                    config: server.config,
                    enabled: !isDeniedByClaude(denied, registeredName, server.config.url),
                    provider: this.providerName,
                    plugin: server.pluginId,
                },
            };
        });
    }

    async listPluginServers(): Promise<MCPServerInfo[]> {
        try {
            return (await this.discoverPluginServers(await this.readSettings())).map((server) => server.info);
        } catch (error) {
            logger.warn({ error, path: this.getSettingsPath() }, "mcp-manager: could not read Claude user settings");
            return [];
        }
    }

    /**
     * Claude Code's global switch for one plugin server is the user-settings denylist:
     * `deniedMcpServers: [{ "serverName": "plugin:<plugin>:<server>" }]`. The plugin stays enabled
     * (verified on Claude Code 2.1.296: `claude mcp get plugin:expo:expo` no longer finds it).
     * Enabling removes exactly those `serverName` entries, and the key when it ends up empty.
     */
    async setPluginServersEnabled(serverNames: string[], enabled: boolean): Promise<WriteResult> {
        const settings = await this.readSettings();
        const registered = new Set(
            (await this.discoverPluginServers(settings))
                .filter((server) => serverNames.includes(server.info.name))
                .map((server) => server.registeredName)
        );

        if (registered.size === 0) {
            return WriteResult.NoChanges;
        }

        const current = deniedEntries(settings);
        const namedIn = (entry: unknown): boolean =>
            isObject(entry) && typeof entry.serverName === "string" && registered.has(entry.serverName);

        if (enabled) {
            const kept = current.filter((entry) => !namedIn(entry));

            if (kept.length === current.length) {
                return WriteResult.NoChanges;
            }

            if (kept.length === 0) {
                delete settings.deniedMcpServers;
            } else {
                settings.deniedMcpServers = kept;
            }
        } else {
            const present = new Set(
                current
                    .filter(isObject)
                    .flatMap((entry) => (typeof entry.serverName === "string" ? [entry.serverName] : []))
            );
            const missing = [...registered].filter((name) => !present.has(name));

            if (missing.length === 0) {
                return WriteResult.NoChanges;
            }

            settings.deniedMcpServers = [...current, ...missing.map((serverName) => ({ serverName }))];
        }

        return this.writeSettings(settings);
    }

    /** Same flow as every harness write (diff, confirm or --yes, backup), aimed at settings.json. */
    private async writeSettings(settings: Record<string, unknown>): Promise<WriteResult> {
        const settingsPath = this.getSettingsPath();
        const oldContent = existsSync(settingsPath) ? await readFile(settingsPath, "utf-8") : "";
        const body = SafeJSON.stringify(settings, null, 2);
        const newContent = oldContent === "" || oldContent.endsWith("\n") ? `${body}\n` : body;

        if (oldContent === newContent) {
            return WriteResult.NoChanges;
        }

        await this.backupManager.showDiff(oldContent, newContent, settingsPath);
        const confirmed = await this.backupManager.askConfirmation();

        if (!confirmed) {
            return WriteResult.Rejected;
        }

        await this.backupManager.createBackup(settingsPath, this.providerName);
        await mkdir(path.dirname(settingsPath), { recursive: true });
        atomicWriteFileSync(settingsPath, newContent, { mode: 0o600 });
        logger.info(chalk.green(`✓ Configuration written to ${settingsPath}`));
        return WriteResult.Applied;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        const config = await this.readConfig();

        // Check global servers first
        if (config.mcpServers?.[serverName]) {
            return this.claudeToUnified(config.mcpServers[serverName]);
        }

        // Check project-specific servers
        if (config.projects) {
            for (const projectConfig of Object.values(config.projects)) {
                if (projectConfig.mcpServers?.[serverName]) {
                    return this.claudeToUnified(projectConfig.mcpServers[serverName]);
                }
            }
        }

        return null;
    }

    async getProjects(): Promise<string[]> {
        const config = await this.readConfig();
        if (!config.projects) {
            return [];
        }
        return Object.keys(config.projects);
    }

    async getServerEnabledStatesPerProject(): Promise<Map<string, Record<string, boolean>>> {
        const config = await this.readConfig();
        const result = new Map<string, Record<string, boolean>>();

        // Get all global servers
        const globalServerNames = config.mcpServers ? Object.keys(config.mcpServers) : [];

        // Initialize map for all global servers
        for (const serverName of globalServerNames) {
            result.set(serverName, {});
        }

        // Process per-project disabledMcpServers
        if (config.projects) {
            for (const [projectPath, projectConfig] of Object.entries(config.projects)) {
                const projectDisabled = new Set(projectConfig.disabledMcpServers || []);

                // For each global server, check if it's disabled in this project
                for (const serverName of globalServerNames) {
                    const isDisabledInProject = projectDisabled.has(serverName);
                    const isEnabledInProject = !isDisabledInProject;

                    if (!result.has(serverName)) {
                        result.set(serverName, {});
                    }
                    result.get(serverName)![projectPath] = isEnabledInProject;
                }

                // Also check project-specific servers
                if (projectConfig.mcpServers) {
                    for (const serverName of Object.keys(projectConfig.mcpServers)) {
                        if (!result.has(serverName)) {
                            result.set(serverName, {});
                        }
                        const isDisabledInProject = projectDisabled.has(serverName);
                        const isEnabledInProject = !isDisabledInProject;
                        result.get(serverName)![projectPath] = isEnabledInProject;
                    }
                }
            }
        }

        return result;
    }

    async enableServer(serverName: string, projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        if (projectPath === null || projectPath === undefined) {
            // Global enable (no project specified = global)
            await this.applyGlobalEnable([serverName], config);
        } else {
            await this.applyProjectEnable([serverName], projectPath, config);
        }

        await this.writeConfig(config);
    }

    async disableServer(serverName: string, projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        if (projectPath === null || projectPath === undefined) {
            // Global disable (no project specified = global)
            await this.applyGlobalDisable([serverName], config);
        } else {
            this.applyProjectDisable([serverName], projectPath, config);
        }

        await this.writeConfig(config);
    }

    async enableServerForAllProjects(serverName: string): Promise<void> {
        await this.enableServer(serverName, null);
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        await this.disableServer(serverName, null);
    }

    async enableServers(
        serverNames: string[],
        projectPath?: string | null,
        options: EnableServersOptions = {}
    ): Promise<WriteResult> {
        const config = await this.readConfig();

        if (projectPath === null || projectPath === undefined) {
            await this.applyGlobalEnable(serverNames, config, options);
        } else {
            await this.applyProjectEnable(serverNames, projectPath, config);
        }

        return this.writeConfig(config);
    }

    async disableServers(serverNames: string[], projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        if (projectPath === null || projectPath === undefined) {
            await this.applyGlobalDisable(serverNames, config);
        } else {
            this.applyProjectDisable(serverNames, projectPath, config);
        }

        return this.writeConfig(config);
    }

    /**
     * Per-project enable. Removes the server names from the project's
     * `disabledMcpServers` list. For servers that are globally disabled
     * (absent from the global `mcpServers`), additionally installs a
     * project-scope entry at `.projects[<path>].mcpServers.<name>` from the
     * unified config — Claude Code DOES honor project-scope entries (it's the
     * same storage `claude mcp add -s local` uses), so this overrides the
     * global disable for that one project. The global state in the unified
     * config (`_meta.enabled.claude = false`) is intentionally left untouched;
     * the override is tracked solely by the presence of the project entry.
     */
    private async applyProjectEnable(
        serverNames: string[],
        projectPath: string,
        config: ClaudeGenericConfig
    ): Promise<void> {
        const existingProject = config.projects?.[projectPath];

        // Remove from the project's disabled list (Claude Code reads this list,
        // so an override entry only works when the name is NOT in it)
        if (existingProject?.disabledMcpServers) {
            existingProject.disabledMcpServers = existingProject.disabledMcpServers.filter(
                (name) => !serverNames.includes(name)
            );
        }

        // Install project-scope override entries for globally-disabled servers
        const needsOverride = serverNames.filter(
            (name) => !config.mcpServers?.[name] && !existingProject?.mcpServers?.[name]
        );
        if (needsOverride.length === 0) {
            return;
        }

        const unified = await readUnifiedConfig();
        const installable = needsOverride.filter((name) => unified.mcpServers[name]);
        if (installable.length === 0) {
            return;
        }

        if (!config.projects) {
            config.projects = {};
        }
        if (!config.projects[projectPath]) {
            config.projects[projectPath] = {};
        }
        const projectConfig = config.projects[projectPath];
        if (!projectConfig.mcpServers) {
            projectConfig.mcpServers = {};
        }
        for (const name of installable) {
            projectConfig.mcpServers[name] = this.unifiedToClaude(stripMeta(unified.mcpServers[name]));
        }
    }

    /**
     * Per-project disable. Removes a project-scope override entry if present
     * (undoing an `enable --project` override) and adds the name to the
     * project's `disabledMcpServers` list.
     */
    private applyProjectDisable(serverNames: string[], projectPath: string, config: ClaudeGenericConfig): void {
        if (!config.projects) {
            config.projects = {};
        }
        if (!config.projects[projectPath]) {
            config.projects[projectPath] = {};
        }
        const projectConfig = config.projects[projectPath];

        if (!projectConfig.disabledMcpServers) {
            projectConfig.disabledMcpServers = [];
        }
        for (const serverName of serverNames) {
            if (projectConfig.mcpServers?.[serverName]) {
                delete projectConfig.mcpServers[serverName];
            }
            if (!projectConfig.disabledMcpServers.includes(serverName)) {
                projectConfig.disabledMcpServers.push(serverName);
            }
        }
    }

    /**
     * Apply a TRUE global disable to the in-memory Claude config:
     * 1. Preserve each server's full config in the unified config with
     *    `_meta.enabled.claude = false` (import it there if missing).
     * 2. Keep the top-level marker (Claude Code ignores it; mcp-manager reads it).
     * 3. Remove the entry from `mcpServers` — the only mechanism Claude Code
     *    honors globally, including projects registered in the future.
     * No project's `disabledMcpServers` list is written. Entries that could not
     * be preserved are NOT removed (no data loss).
     */
    private async applyGlobalDisable(serverNames: string[], config: ClaudeGenericConfig): Promise<void> {
        if (!config.disabledMcpServers) {
            config.disabledMcpServers = [];
        }

        const safeToRemove = await this.preserveServersInUnifiedConfig(serverNames, config);

        for (const serverName of serverNames) {
            // Top-level marker (ignored by Claude Code, kept for back-compat)
            if (!config.disabledMcpServers.includes(serverName)) {
                config.disabledMcpServers.push(serverName);
            }

            // TRUE global disable: remove the entry from mcpServers
            if (config.mcpServers?.[serverName]) {
                if (safeToRemove.has(serverName)) {
                    delete config.mcpServers[serverName];
                } else {
                    logger.warn(
                        chalk.yellow(
                            `⚠ '${serverName}' was NOT removed from mcpServers in ${this.configPath} because its config could not be preserved in the unified config, so Claude Code still loads it in every project.`
                        )
                    );
                }
            }
        }
    }

    /**
     * Apply a global enable to the in-memory Claude config: restore the entry
     * into `mcpServers` from the unified config (a TRUE global disable removed
     * it) and drop the top-level marker. Project lists stay as they are unless
     * `clearProjectOverrides` asks to take the name off every list that still
     * names it; without it, one warning gives the count and the flag.
     */
    private async applyGlobalEnable(
        serverNames: string[],
        config: ClaudeGenericConfig,
        options: EnableServersOptions = {}
    ): Promise<void> {
        await this.restoreServersFromUnifiedConfig(serverNames, config);

        for (const serverName of serverNames) {
            if (config.disabledMcpServers) {
                config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
            }

            const listing = Object.values(config.projects ?? {}).filter((project) =>
                project.disabledMcpServers?.includes(serverName)
            );

            if (listing.length === 0) {
                continue;
            }

            if (options.clearProjectOverrides) {
                for (const project of listing) {
                    project.disabledMcpServers = project.disabledMcpServers?.filter((name) => name !== serverName);
                }

                logger.info(
                    `'${serverName}': taking it off the disabledMcpServers list of ${listing.length} project(s) (--clear-project-overrides)`
                );
                continue;
            }

            logger.warn(
                chalk.yellow(
                    `⚠ '${serverName}' is enabled globally, but ${listing.length} project(s) still list it in their disabledMcpServers, so it stays off there. A global enable changes only the global switch. To turn it on in all of them: ${toolCommand("mcp-manager enable", serverName, "-p", "claude", "--clear-project-overrides")}. For one project: ${toolCommand("mcp-manager enable", serverName, "-p", "claude", "--project", "<path>")}`
                )
            );
        }
    }

    /**
     * Ensure full server configs are preserved in the unified config with
     * `_meta.enabled.claude = false` BEFORE they are removed from
     * ~/.claude.json. Returns the set of server names whose config body is
     * safely stored in the unified config (pre-existing or successfully
     * imported) — only those may be removed without data loss.
     */
    private async preserveServersInUnifiedConfig(
        serverNames: string[],
        claudeConfig: ClaudeGenericConfig
    ): Promise<Set<string>> {
        const unified = await readUnifiedConfig();
        const preExisting = new Set<string>();
        const imported = new Set<string>();

        for (const serverName of serverNames) {
            let entry = unified.mcpServers[serverName];
            if (entry) {
                preExisting.add(serverName);
            } else {
                const providerEntry = claudeConfig.mcpServers?.[serverName];
                if (!providerEntry) {
                    continue; // Not installed — nothing to preserve or remove
                }
                entry = this.claudeToUnified(providerEntry);
                unified.mcpServers[serverName] = entry;
                imported.add(serverName);
            }

            if (!entry._meta) {
                entry._meta = { enabled: {} };
            }
            if (!entry._meta.enabled) {
                entry._meta.enabled = {};
            }
            entry._meta.enabled.claude = false;
        }

        // writeUnifiedConfig no-ops (returns false) when nothing changed; with
        // pending imports a `false` means the write was rejected — those
        // entries are NOT preserved and must not be removed.
        const written = await writeUnifiedConfig(unified);
        return written ? new Set([...preExisting, ...imported]) : preExisting;
    }

    /**
     * Restore entries removed by a TRUE global disable: copy the server config
     * back into `mcpServers` from the unified config (where it was preserved).
     */
    private async restoreServersFromUnifiedConfig(serverNames: string[], config: ClaudeGenericConfig): Promise<void> {
        const missing = serverNames.filter((name) => !config.mcpServers?.[name]);
        if (missing.length === 0) {
            return;
        }

        const unified = await readUnifiedConfig();
        for (const name of missing) {
            const entry = unified.mcpServers[name];
            if (!entry) {
                continue; // Not in unified config — nothing to restore
            }
            if (!config.mcpServers) {
                config.mcpServers = {};
            }
            config.mcpServers[name] = this.unifiedToClaude(stripMeta(entry));
        }
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult> {
        // Strip _meta before processing (unified utility ensures _meta never reaches providers)
        const cleanConfig = stripMeta(config);
        const claudeConfig = await this.readConfig();

        if (!claudeConfig.mcpServers) {
            claudeConfig.mcpServers = {};
        }

        claudeConfig.mcpServers[serverName] = this.unifiedToClaude(cleanConfig);

        // Ensure it's enabled by removing from the top-level marker. Project lists
        // are not touched: an install is a global operation (see the class comment).
        if (claudeConfig.disabledMcpServers) {
            claudeConfig.disabledMcpServers = claudeConfig.disabledMcpServers.filter((name) => name !== serverName);
        }

        return this.writeConfig(claudeConfig);
    }

    async removeServers(serverNames: string[]): Promise<WriteResult> {
        const config = await this.readConfig();

        for (const serverName of serverNames) {
            // Global entry
            if (config.mcpServers?.[serverName]) {
                delete config.mcpServers[serverName];
            }
            // Top-level marker (mcp-manager-only)
            if (config.disabledMcpServers) {
                config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
            }
            // Project-scope entries (incl. per-project overrides). The
            // per-project disabledMcpServers lists are intentionally left
            // untouched — harmless leftovers, and scrubbing them would churn
            // dozens of project entries for no behavioral gain.
            if (config.projects) {
                for (const projectConfig of Object.values(config.projects)) {
                    if (projectConfig.mcpServers?.[serverName]) {
                        delete projectConfig.mcpServers[serverName];
                    }
                }
            }
        }

        return this.writeConfig(config);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }
        if (!config.disabledMcpServers) {
            config.disabledMcpServers = [];
        }

        for (const [name, serverConfig] of Object.entries(servers)) {
            const cleanConfig = stripMeta(serverConfig);

            const enabledState = serverConfig._meta?.enabled?.claude;
            const isGloballyEnabled = enabledState === true;
            const isGloballyDisabled = enabledState === false;

            if (isGloballyDisabled) {
                // TRUE global disable = absent from mcpServers (Claude Code
                // never reads the top-level disabledMcpServers key, and the
                // per-project sweep misses projects registered later).
                delete config.mcpServers[name];
            } else {
                config.mcpServers[name] = this.unifiedToClaude(cleanConfig);
            }

            if (isGloballyEnabled) {
                config.disabledMcpServers = config.disabledMcpServers.filter((n) => n !== name);
            } else if (!config.disabledMcpServers.includes(name)) {
                config.disabledMcpServers.push(name);
            }

            // Per-project override entry (.projects[<path>].mcpServers.<name>):
            // refresh its config from the unified config, NEVER delete it.
            for (const projectConfig of Object.values(config.projects ?? {})) {
                if (projectConfig.mcpServers?.[name]) {
                    projectConfig.mcpServers[name] = this.unifiedToClaude(cleanConfig);
                }
            }

            // A boolean or unset state is the global switch only, handled above.
            // A per-project map writes the lists of the projects it names, no others.
            if (typeof enabledState === "object" && enabledState !== null) {
                this.applyNamedProjectStates(name, enabledState, config);
            }
        }

        return this.writeConfig(config);
    }

    /**
     * Write one server into the `disabledMcpServers` lists of the projects a per-project
     * `_meta.enabled.claude` map names: `true` takes it off that project's list, `false`
     * puts it on. A project missing from ~/.claude.json is not created, and a project with
     * a project-scope override entry keeps it (the override wins over the map).
     */
    private applyNamedProjectStates(name: string, states: PerProjectEnabledState, config: ClaudeGenericConfig): void {
        for (const [projectPath, enabled] of Object.entries(states)) {
            const projectConfig = config.projects?.[projectPath];

            if (!projectConfig || projectConfig.mcpServers?.[name]) {
                continue;
            }

            if (enabled) {
                if (projectConfig.disabledMcpServers?.includes(name)) {
                    projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter((n) => n !== name);
                }

                continue;
            }

            if (!projectConfig.disabledMcpServers) {
                projectConfig.disabledMcpServers = [];
            }

            if (!projectConfig.disabledMcpServers.includes(name)) {
                projectConfig.disabledMcpServers.push(name);
            }
        }
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const claudeConfig = config as ClaudeGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (claudeConfig.mcpServers) {
            for (const [name, serverConfig] of Object.entries(claudeConfig.mcpServers)) {
                // Strip _meta if it somehow got into provider config (shouldn't happen, but safety check)
                result[name] = stripMeta(this.claudeToUnified(serverConfig));
            }
        }

        return result;
    }

    /**
     * Check if a server is enabled in this provider's config
     */
    async isServerEnabled(serverName: string): Promise<boolean> {
        const config = await this.readConfig();
        const disabledServers = new Set(config.disabledMcpServers || []);
        return !disabledServers.has(serverName);
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: ClaudeGenericConfig = {
            mcpServers: {},
            disabledMcpServers: [],
        };

        for (const [name, unified] of Object.entries(servers)) {
            // Read enabled state using utility method (checks global enablement)
            const isEnabled = this.isServerEnabledInMeta(unified);

            // Strip _meta before converting
            const cleanConfig = stripMeta(unified);
            config.mcpServers![name] = this.unifiedToClaude(cleanConfig);

            if (!isEnabled) {
                config.disabledMcpServers?.push(name);
            }
        }

        return config;
    }

    private claudeToUnified(claude: ClaudeMCPServerConfig): UnifiedMCPServerConfig {
        return {
            type: (claude.type as "stdio" | "sse" | "http") || "stdio",
            command: claude.command,
            args: claude.args,
            env: claude.env,
            url: claude.url,
            headers: (claude as unknown as { headers?: Record<string, string> }).headers,
        };
    }

    private unifiedToClaude(unified: UnifiedMCPServerConfig): ClaudeMCPServerConfig {
        return {
            type: unified.type || "stdio",
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url,
            ...(unified.headers && { headers: unified.headers }),
        } as ClaudeMCPServerConfig;
    }
}
