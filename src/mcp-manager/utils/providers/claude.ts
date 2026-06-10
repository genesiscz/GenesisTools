import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "@app/logger";
import { readUnifiedConfig, stripMeta, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import type { ClaudeGenericConfig, ClaudeMCPServerConfig } from "./claude.types.js";
import type { MCPServerInfo, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, WriteResult } from "./types.js";

/**
 * Claude Desktop MCP provider.
 * Manages MCP servers in ~/.claude.json
 *
 * IMPORTANT (verified against the Claude Code binary): Claude Code reads
 * `disabledMcpServers` ONLY from per-project entries
 * (`.projects[<cwd>].disabledMcpServers`). The TOP-LEVEL `disabledMcpServers`
 * key is NEVER read by Claude Code — it is an mcp-manager-only marker. A
 * per-project sweep covers only projects that exist at sweep time; projects
 * registered later load the server again. The only mechanism Claude Code
 * honors globally (including future projects) is the server NOT existing in
 * `mcpServers` — so a TRUE global disable removes the entry (after preserving
 * its full config in the unified config with `_meta.enabled.claude = false`).
 */
export class ClaudeProvider extends MCPProvider {
    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
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

    async enableServers(serverNames: string[], projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        if (projectPath === null || projectPath === undefined) {
            await this.applyGlobalEnable(serverNames, config);
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
        const projectConfig = config.projects?.[projectPath];
        if (!projectConfig) {
            return;
        }

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
     * 2. Keep the top-level marker + per-project sweep for back-compat
     *    (Claude Code ignores the top-level key; the sweep covers only
     *    currently-registered projects).
     * 3. Remove the entry from `mcpServers` — the only mechanism Claude Code
     *    honors globally, including projects registered in the future.
     * Entries that could not be preserved are NOT removed (no data loss).
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

            // Per-project sweep (covers existing projects, kept for back-compat).
            // Projects with a project-scope override entry for this server are
            // SKIPPED — the override (enable --project) wins over the global
            // disable and must never be clobbered.
            if (config.projects) {
                for (const projectConfig of Object.values(config.projects)) {
                    if (projectConfig.mcpServers?.[serverName]) {
                        continue;
                    }
                    if (!projectConfig.disabledMcpServers) {
                        projectConfig.disabledMcpServers = [];
                    }
                    if (!projectConfig.disabledMcpServers.includes(serverName)) {
                        projectConfig.disabledMcpServers.push(serverName);
                    }
                }
            }

            // TRUE global disable: remove the entry from mcpServers
            if (config.mcpServers?.[serverName]) {
                if (safeToRemove.has(serverName)) {
                    delete config.mcpServers[serverName];
                } else {
                    logger.warn(
                        chalk.yellow(
                            `⚠ '${serverName}' was NOT removed from mcpServers in ${this.configPath} because its config could not be preserved in the unified config — the disable will not cover projects registered later.`
                        )
                    );
                }
            }
        }
    }

    /**
     * Apply a global enable to the in-memory Claude config: restore the entry
     * into `mcpServers` from the unified config (a TRUE global disable removed
     * it) and clean the top-level + all per-project disabled lists.
     */
    private async applyGlobalEnable(serverNames: string[], config: ClaudeGenericConfig): Promise<void> {
        await this.restoreServersFromUnifiedConfig(serverNames, config);

        for (const serverName of serverNames) {
            if (config.disabledMcpServers) {
                config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
            }
            if (config.projects) {
                for (const projectConfig of Object.values(config.projects)) {
                    if (projectConfig.disabledMcpServers) {
                        projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter(
                            (name) => name !== serverName
                        );
                    }
                }
            }
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

        // Ensure it's enabled by removing from disabled list (modify same config object)
        if (claudeConfig.disabledMcpServers) {
            claudeConfig.disabledMcpServers = claudeConfig.disabledMcpServers.filter((name) => name !== serverName);
        }

        // Also remove from project-specific disabled lists
        if (claudeConfig.projects) {
            for (const projectConfig of Object.values(claudeConfig.projects)) {
                if (projectConfig.disabledMcpServers) {
                    projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter(
                        (name) => name !== serverName
                    );
                }
            }
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

            if (config.projects) {
                for (const [projectPath, projectConfig] of Object.entries(config.projects)) {
                    // Per-project override entry (.projects[<path>].mcpServers.<name>)
                    // wins over the global/meta state: refresh its config from
                    // the unified config, but NEVER delete it and NEVER (re-)add
                    // the name to the project's disabled list — otherwise the
                    // next sync would clobber an `enable --project` override.
                    if (projectConfig.mcpServers?.[name]) {
                        projectConfig.mcpServers[name] = this.unifiedToClaude(cleanConfig);
                        continue;
                    }

                    if (!projectConfig.disabledMcpServers) {
                        projectConfig.disabledMcpServers = [];
                    }

                    const isEnabledForProject = this.isServerEnabledInMeta(serverConfig, projectPath);

                    if (isEnabledForProject) {
                        projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter((n) => n !== name);
                    } else if (!projectConfig.disabledMcpServers.includes(name)) {
                        projectConfig.disabledMcpServers.push(name);
                    }
                }
            }
        }

        return this.writeConfig(config);
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
