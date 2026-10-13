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
import { namesGrokWouldStartFromClaudeJson } from "./grok.js";
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

/** Applied when either write applied; otherwise the two writes changed nothing. */
function combineWrites(first: WriteResult, second: WriteResult): WriteResult {
    if (second === WriteResult.Rejected) {
        return second;
    }

    return first === WriteResult.Applied || second === WriteResult.Applied
        ? WriteResult.Applied
        : WriteResult.NoChanges;
}

/** How many projects run `name` through their own project-scope entry (an `enable --project` override). */
function projectsOverriding(config: ClaudeGenericConfig, name: string): number {
    return Object.values(config.projects ?? {}).filter((project) => project.mcpServers?.[name]).length;
}

/** Drop names from the top-level `disabledMcpServers` marker, and the key once it is empty. */
function dropTopLevelMarker(config: ClaudeGenericConfig, names: string[]): void {
    if (!config.disabledMcpServers) {
        return;
    }

    config.disabledMcpServers = config.disabledMcpServers.filter((name) => !names.includes(name));

    if (config.disabledMcpServers.length === 0) {
        delete config.disabledMcpServers;
    }
}

/**
 * Claude Desktop MCP provider.
 * Manages MCP servers in ~/.claude.json
 *
 * The global switch (verified on Claude Code 2.1.296, research note
 * 2026-10-13-ClaudeCodeGlobalMcpSwitch.md): a
 * `deniedMcpServers: [{ "serverName": "<name>" }]` entry in
 * `~/.claude/settings.json`. It covers every project, also one registered later,
 * and the config stays in `mcpServers`. A denied server is ABSENT from
 * `claude mcp list` and `/mcp` (not shown as disabled), and `/mcp` cannot turn
 * it back on ("blocked by enterprise managed policy"). The deny matches the
 * name in every scope, so a project-scope entry of the same name is blocked too.
 * The top-level `disabledMcpServers` key in `~/.claude.json` does nothing;
 * mcp-manager no longer writes it and removes it on sync. Claude Code reads
 * `disabledMcpServers` only from the current project entry.
 *
 * Grok reads `~/.claude.json` top-level `mcpServers` too, and Claude's deny does
 * not reach Grok. So a server that stays off in Claude is put back into
 * `mcpServers` only when Grok would not start it from there (see
 * `namesGrokWouldStartFromClaudeJson`) or the unified config enables it for Grok.
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
        // A server with `_meta.enabled.claude === false` is put back into
        // mcpServers by syncServers itself, which first checks that Grok would
        // not start it from ~/.claude.json. Everything else installs up front.
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
        const denied = await this.readDeniedEntries();
        const servers: MCPServerInfo[] = [];
        const globalNames = new Set<string>();

        // Global servers: off when the user-settings denylist names them.
        if (config.mcpServers) {
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                globalNames.add(name);
                servers.push({
                    name,
                    config: this.claudeToUnified(serverConfig),
                    enabled: !isDeniedByClaude(denied, name, serverConfig.url),
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
                                enabled:
                                    !projectDisabled.has(name) && !isDeniedByClaude(denied, name, serverConfig.url),
                                provider: `${this.providerName}:${projectPath}`,
                            });
                        }
                    }
                }
            }
        }

        // A server an older delete-based disable removed from ~/.claude.json (or one
        // kept out because Grok would start it): surface it from the unified config
        // as disabled so it does not look "not installed".
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

    /** The `deniedMcpServers` entries of the user settings; an unreadable file counts as none, with a warning. */
    private async readDeniedEntries(): Promise<unknown[]> {
        try {
            return deniedEntries(await this.readSettings());
        } catch (error) {
            logger.warn({ error, path: this.getSettingsPath() }, "mcp-manager: could not read Claude user settings");
            return [];
        }
    }

    /**
     * Edit the user-settings denylist in memory: add `{ serverName }` for each name in `deny` that no
     * entry names yet, and remove exactly the `serverName` entries for the names in `allow` (a
     * `serverUrl` pattern is never touched). The key goes when the list ends up empty. Returns
     * whether anything changed.
     */
    private applyDenyChanges(settings: Record<string, unknown>, change: { deny: string[]; allow: string[] }): boolean {
        const current = deniedEntries(settings);
        const named = (entry: unknown): string | undefined =>
            isObject(entry) && typeof entry.serverName === "string" ? entry.serverName : undefined;
        const kept = current.filter((entry) => {
            const name = named(entry);
            return name === undefined || !change.allow.includes(name);
        });
        const present = new Set(kept.map(named));
        const added = [...new Set(change.deny)].filter((name) => !present.has(name));

        if (kept.length === current.length && added.length === 0) {
            return false;
        }

        const next = [...kept, ...added.map((serverName) => ({ serverName }))];

        if (next.length === 0) {
            delete settings.deniedMcpServers;
        } else {
            settings.deniedMcpServers = next;
        }

        return true;
    }

    /** Deny (`denied`) or allow the given registered server names in `~/.claude/settings.json`. */
    private async setDeniedServerNames(names: string[], denied: boolean): Promise<WriteResult> {
        const settings = await this.readSettings();
        const changed = this.applyDenyChanges(
            settings,
            denied ? { deny: names, allow: [] } : { deny: [], allow: names }
        );

        return changed ? this.writeSettings(settings) : WriteResult.NoChanges;
    }

    /**
     * Claude Code's global switch for one plugin server is the user-settings denylist:
     * `deniedMcpServers: [{ "serverName": "plugin:<plugin>:<server>" }]`. The plugin stays enabled
     * (verified on Claude Code 2.1.296: `claude mcp get plugin:expo:expo` no longer finds it).
     * Enabling removes exactly those `serverName` entries, and the key when it ends up empty.
     */
    async setPluginServersEnabled(serverNames: string[], enabled: boolean): Promise<WriteResult> {
        const settings = await this.readSettings();
        const registered = [
            ...new Set(
                (await this.discoverPluginServers(settings))
                    .filter((server) => serverNames.includes(server.info.name))
                    .map((server) => server.registeredName)
            ),
        ];

        if (registered.length === 0) {
            return WriteResult.NoChanges;
        }

        const changed = this.applyDenyChanges(
            settings,
            enabled ? { deny: [], allow: registered } : { deny: registered, allow: [] }
        );

        return changed ? this.writeSettings(settings) : WriteResult.NoChanges;
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
        // Atomic like every harness write: a crash or a full disk leaves the old settings.json, never a short one.
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
        await this.enableServers([serverName], projectPath);
    }

    async disableServer(serverName: string, projectPath?: string | null): Promise<void> {
        await this.disableServers([serverName], projectPath);
    }

    async enableServerForAllProjects(serverName: string): Promise<void> {
        await this.enableServer(serverName, null);
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        await this.disableServer(serverName, null);
    }

    /**
     * A global enable writes ~/.claude.json first (restore the entry), then lifts the deny in
     * settings.json. A rejected second write leaves the server denied, so it stays off.
     */
    async enableServers(
        serverNames: string[],
        projectPath?: string | null,
        options: EnableServersOptions = {}
    ): Promise<WriteResult> {
        const config = await this.readConfig();

        if (projectPath !== null && projectPath !== undefined) {
            await this.applyProjectEnable(serverNames, projectPath, config);
            return this.writeConfig(config);
        }

        await this.applyGlobalEnable(serverNames, config, options);
        const written = await this.writeConfig(config);

        if (written === WriteResult.Rejected) {
            return written;
        }

        return combineWrites(written, await this.setDeniedServerNames(serverNames, false));
    }

    /**
     * A global disable denies the server in settings.json FIRST, then fixes ~/.claude.json (entry
     * kept or put back, top-level marker dropped). A rejected deny writes nothing, so a disable
     * can never restore an entry without its deny and turn the server on. A server that some
     * project runs through its own project-scope entry is not denied (see `applyGlobalDisable`).
     */
    async disableServers(serverNames: string[], projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        if (projectPath !== null && projectPath !== undefined) {
            this.applyProjectDisable(serverNames, projectPath, config);
            return this.writeConfig(config);
        }

        const overridden = serverNames.filter((name) => projectsOverriding(config, name) > 0);
        const deniable = serverNames.filter((name) => !overridden.includes(name));
        const denied = deniable.length > 0 ? await this.setDeniedServerNames(deniable, true) : WriteResult.NoChanges;

        if (denied === WriteResult.Rejected) {
            return denied;
        }

        await this.applyGlobalDisable(serverNames, config, overridden);
        return combineWrites(denied, await this.writeConfig(config));
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
        const denied = await this.readDeniedEntries();

        for (const name of serverNames.filter((server) => isDeniedByClaude(denied, server, undefined))) {
            logger.warn(
                chalk.yellow(
                    `⚠ '${name}' is denied globally (deniedMcpServers), and Claude Code applies that in every project, project-scope entries included, so a per-project enable cannot turn it on. Enable it globally, then disable it in the projects where you do not want it: ${toolCommand("mcp-manager disable", name, "-p", "claude", "--project", "<path>")}`
                )
            );
        }

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
     * The ~/.claude.json half of a global disable (the deny itself is in settings.json):
     * 1. Record `_meta.enabled.claude = false` in the unified config (import the config there if
     *    it is missing).
     * 2. Keep the entry in `mcpServers`; put it back from the unified config when an older
     *    delete-based disable removed it, unless Grok would then start it (`restoreMissing`).
     * 3. Drop the names from the top-level `disabledMcpServers` marker, which Claude Code ignores.
     * No project's `disabledMcpServers` list is written.
     *
     * Exception, `overridden`: a server that some project runs through its own project-scope entry.
     * The deny matches the name in every scope and would switch those projects off too, so such a
     * server keeps the older switch instead: absent from the global `mcpServers` (its config stays in
     * the unified config and in the project entries), not denied.
     */
    private async applyGlobalDisable(
        serverNames: string[],
        config: ClaudeGenericConfig,
        overridden: string[] = []
    ): Promise<void> {
        const preserved = await this.preserveServersInUnifiedConfig(serverNames, config);
        await this.restoreMissing(
            serverNames.filter((name) => !overridden.includes(name)),
            config,
            { staysOffInClaude: true }
        );
        dropTopLevelMarker(config, serverNames);

        for (const name of overridden) {
            if (config.mcpServers?.[name] && preserved.has(name)) {
                delete config.mcpServers[name];
            }

            this.reportOverridden(name, config);
        }
    }

    private reportOverridden(name: string, config: ClaudeGenericConfig): void {
        logger.warn(
            chalk.yellow(
                `⚠ '${name}' keeps the older global switch (absent from mcpServers, not denied): ${projectsOverriding(config, name)} project(s) run it through a project-scope entry, and a deny would switch those projects off too.`
            )
        );
    }

    /**
     * The ~/.claude.json half of a global enable (the caller then lifts the deny): put the entry
     * back into `mcpServers` when an older delete-based disable removed it, and drop the top-level
     * marker. Grok sees a restored entry as well; that matches the old behaviour of a global
     * enable, and the server is meant to run. Project lists stay as they are unless
     * `clearProjectOverrides` asks to take the name off every list that still names it; without
     * it, one warning gives the count and the flag.
     */
    private async applyGlobalEnable(
        serverNames: string[],
        config: ClaudeGenericConfig,
        options: EnableServersOptions = {}
    ): Promise<void> {
        await this.restoreMissing(serverNames, config, { staysOffInClaude: false });
        dropTopLevelMarker(config, serverNames);

        for (const serverName of serverNames) {
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
     * Record `_meta.enabled.claude = false` in the unified config, importing a server's config
     * there when it is missing. Returns the names whose config the unified config now holds.
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
     * Put entries an older delete-based disable removed back into `mcpServers`, from the unified
     * config (or from `source` when the caller has the projected config). For a server that stays
     * off in Claude (`staysOffInClaude`), Grok decides: it reads `mcpServers` too and Claude's deny
     * does not reach it, so the entry is put back only when Grok would not start it or the unified
     * config enables it for Grok. Otherwise it stays out, and Claude's deny still covers it.
     */
    private async restoreMissing(
        serverNames: string[],
        config: ClaudeGenericConfig,
        opts: { staysOffInClaude: boolean; source?: Record<string, UnifiedMCPServerConfig> }
    ): Promise<void> {
        const missing = serverNames.filter((name) => !config.mcpServers?.[name]);
        if (missing.length === 0) {
            return;
        }

        const unified = await readUnifiedConfig();
        const grokWouldStart = opts.staysOffInClaude
            ? await namesGrokWouldStartFromClaudeJson(missing, unified)
            : new Set<string>();

        for (const name of missing) {
            const entry = opts.source?.[name] ?? unified.mcpServers[name];
            if (!entry) {
                continue; // Not in unified config — nothing to restore
            }

            if (grokWouldStart.has(name) && unified.mcpServers[name]?._meta?.enabled?.grok !== true) {
                logger.warn(
                    chalk.yellow(
                        `⚠ '${name}' stays out of mcpServers in ${this.configPath}: Grok loads that list, has no table for it and would start it, and Claude's deny does not reach Grok. Claude's deny still keeps it off in Claude.`
                    )
                );
                continue;
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

        const written = await this.writeConfig(config);

        if (written === WriteResult.Rejected) {
            return written;
        }

        // A deny entry left behind would block a later server of the same name.
        return combineWrites(written, await this.setDeniedServerNames(serverNames, false));
    }

    /**
     * `_meta.enabled.claude === false`: denied in settings.json, and the config kept in (or put back
     * into) `mcpServers`, Grok permitting (`restoreMissing`). `true`: in `mcpServers`, and its
     * `serverName` deny entry removed. Unset or a per-project map: in `mcpServers`, deny left as it
     * is. The top-level `disabledMcpServers` marker is removed: Claude Code never reads it. The
     * denylist is written first; when that write is rejected, ~/.claude.json is not written either,
     * so a sync never puts an entry back without its deny.
     */
    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        const settings = await this.readSettings();
        const current = await this.readConfig();
        const disabled = Object.keys(servers).filter((name) => servers[name]._meta?.enabled?.claude === false);
        // Same exception as a global disable: a server some project overrides keeps the older switch.
        const overridden = disabled.filter((name) => projectsOverriding(current, name) > 0);
        const deny = disabled.filter((name) => !overridden.includes(name));
        const allow = Object.keys(servers).filter((name) => servers[name]._meta?.enabled?.claude === true);
        let denyResult = WriteResult.NoChanges;

        if (this.applyDenyChanges(settings, { deny, allow })) {
            denyResult = await this.writeSettings(settings);

            if (denyResult === WriteResult.Rejected) {
                return denyResult;
            }
        }

        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        delete config.disabledMcpServers;
        await this.restoreMissing(deny, config, { staysOffInClaude: true, source: servers });

        for (const name of overridden) {
            delete config.mcpServers[name];
            this.reportOverridden(name, config);
        }

        for (const [name, serverConfig] of Object.entries(servers)) {
            const cleanConfig = stripMeta(serverConfig);
            const enabledState = serverConfig._meta?.enabled?.claude;

            // A disabled server keeps its config in mcpServers (the deny is the switch); one that
            // restoreMissing kept out because of Grok, or an overridden one, stays out.
            if (enabledState !== false || (config.mcpServers[name] && !overridden.includes(name))) {
                config.mcpServers[name] = this.unifiedToClaude(cleanConfig);
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

        return combineWrites(denyResult, await this.writeConfig(config));
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
        const url = (await this.readConfig()).mcpServers?.[serverName]?.url;
        return !isDeniedByClaude(await this.readDeniedEntries(), serverName, url);
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
