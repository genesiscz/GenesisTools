import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { EnabledMcpServers, HarnessSyncMap, MCPServerMeta } from "@app/mcp-manager/utils/types.js";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import chalk from "chalk";

/**
 * Result of a write operation to a provider config.
 * Distinguishes between:
 * - Applied: Changes were written to the config
 * - NoChanges: No changes were needed (already in desired state)
 * - Rejected: User rejected the confirmation prompt
 */
export enum WriteResult {
    Applied = "applied",
    NoChanges = "no_changes",
    Rejected = "rejected",
}

export type McpAuthKind = "oauth" | "bearer" | "none";

export type McpAuthPolicy = "open-dcr" | "static-client" | "device-code" | "figma-client-name" | "borrow-forbidden";

export interface McpServerAuth {
    kind: McpAuthKind;
    gateway?: boolean;
    policy?: McpAuthPolicy;
    resource?: string;
    authorizationServer?: string;
    tokenEndpoint?: string;
    clientName?: string;
    /** Fixed loopback redirect for a static-client server; it must match the one registered with the provider. */
    redirectUri?: string;
}

export interface McpGatewayListen {
    host?: string;
    port?: number;
}

export interface McpGatewayConfig {
    listen?: McpGatewayListen;
}

/**
 * Unified MCP server configuration interface.
 * Represents a server configuration that can be synced across providers.
 */
export interface UnifiedMCPServerConfig {
    // Transport identification
    type?: "stdio" | "sse" | "http";

    // STDIO transport (most common)
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;

    // HTTP/SSE transport
    url?: string;
    httpUrl?: string;
    headers?: Record<string, string>;

    /**
     * GenesisTools-owned auth. Stays in the unified config.
     * Provider projections get a loopback URL plus a local header, never these fields.
     */
    auth?: McpServerAuth;

    /**
     * Meta information for this server.
     * This field is NOT synchronized to/from providers.
     * Contains enabled state per provider.
     */
    _meta?: MCPServerMeta;

    // Platform-specific extensions
    [key: string]: unknown;
}

/**
 * Unified MCP configuration schema for ~/mcp.json
 */
export interface UnifiedMCPConfig {
    mcpServers: Record<string, UnifiedMCPServerConfig>;
    gateway?: McpGatewayConfig;
    /**
     * Enabled state for MCP servers per provider.
     * This is a duplicate of _meta.enabled information for easier access.
     * Maps server name to enabled state per provider.
     */
    enabledMcpServers?: EnabledMcpServers;
    /**
     * Per-harness homes for sync-to and sync-from.
     * Missing harnesses are filled with defaults on the next sync or save.
     */
    harnesses?: HarnessSyncMap;
    [key: string]: unknown;
}

/** What {@link MCPProvider.writeCycle} needs to write one harness file. */
export interface WriteCycleInput<T> {
    read: () => Promise<T>;
    /** The next value, or `null` when there is nothing to write. May mutate and return `current`. */
    change: (current: T) => T | null | Promise<T | null>;
    /** The file text; `previous` is the text on disk ("" for a new file), for a serializer that keeps its trailing newline. */
    serialize: (next: T, previous: string) => string;
    path: string;
    /** What the file holds, for the log: "Cursor MCP servers", "Claude user settings". */
    describe: string;
}

/** Extra behaviour of a global enable. */
export interface EnableServersOptions {
    /**
     * Claude: also take the server off every `.projects[<path>].disabledMcpServers` list that
     * still names it. Without it a global enable writes only the global switch.
     */
    clearProjectOverrides?: boolean;
}

/**
 * Information about an MCP server including its status
 */
export interface MCPServerInfo {
    name: string;
    config: UnifiedMCPServerConfig;
    enabled: boolean;
    provider: string;
    /** Plugin id (`<plugin>@<marketplace>`) when an enabled plugin provides this server, not the unified config. */
    plugin?: string;
    /** Harness home the plugin entry was read from, for a provider with several homes (Codex). */
    home?: string;
    /**
     * The file this harness loads the server from when that is not its own config, e.g.
     * `~/.claude.json` for a server Grok takes over through its Claude compatibility.
     */
    via?: string;
}

import { BackupManager } from "@app/mcp-manager/utils/backup.js";

/**
 * Base abstract class for MCP configuration providers.
 * Each provider (Claude, Gemini, Codex, Cursor) extends this class.
 */
export abstract class MCPProvider {
    protected configPath: string;
    protected providerName: string;
    protected backupManager: BackupManager;

    constructor(configPath: string, providerName: string) {
        this.configPath = configPath;
        this.providerName = providerName;
        this.backupManager = new BackupManager();
    }

    /**
     * Get the name of this provider
     */
    getName(): string {
        return this.providerName;
    }

    /**
     * Get the configuration file path
     */
    getConfigPath(): string {
        return this.configPath;
    }

    /**
     * The one write of every harness file: read, change, serialize, diff against the bytes on disk,
     * confirm (or `--yes`), back up, then replace the file atomically. A `change` that returns
     * `null` leaves the file alone, even when the serializer would lay it out differently.
     */
    protected async writeCycle<T>(input: WriteCycleInput<T>): Promise<WriteResult> {
        const next = await input.change(await input.read());

        if (next === null) {
            return WriteResult.NoChanges;
        }

        const oldContent = existsSync(input.path) ? await readFile(input.path, "utf-8") : "";
        const newContent = input.serialize(next, oldContent);

        if (oldContent === newContent) {
            return WriteResult.NoChanges;
        }

        await this.backupManager.showDiff(oldContent, newContent, input.path);

        if (!(await this.backupManager.askConfirmation())) {
            logger.debug({ path: input.path, describe: input.describe }, "mcp-manager: write rejected");
            return WriteResult.Rejected;
        }

        await this.backupManager.createBackup(input.path, this.providerName);
        // Atomic: these are other apps' configs (~/.claude.json, Codex, Grok, Cursor, Gemini). A full disk or
        // a crash mid-write must leave the user's file as it was, never truncated. It creates the folder too.
        atomicWriteFileSync(input.path, newContent, { mode: 0o600 });
        logger.info(chalk.green(`✓ Configuration written to ${input.path}`));
        return WriteResult.Applied;
    }

    /**
     * Check if the configuration file exists
     */
    abstract configExists(): Promise<boolean>;

    /**
     * Read the configuration file
     */
    abstract readConfig(): Promise<unknown>;

    /**
     * Get list of all MCP servers (enabled and disabled)
     */
    abstract listServers(): Promise<MCPServerInfo[]>;

    /**
     * Get full configuration of a specific MCP server
     */
    abstract getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null>;

    /**
     * Enable multiple MCP servers in a single batch operation
     * @param serverNames - Names of the servers to enable
     * @param projectPath - Optional project path for project-specific enabling
     * @param options - Extra behaviour of a global enable; a provider without project lists ignores it
     * @returns WriteResult indicating whether changes were applied, no changes needed, or rejected
     */
    abstract enableServers(
        serverNames: string[],
        projectPath?: string | null,
        options?: EnableServersOptions
    ): Promise<WriteResult>;

    /**
     * Disable multiple MCP servers in a single batch operation
     * @param serverNames - Names of the servers to disable
     * @param projectPath - Optional project path for project-specific disabling
     * @returns WriteResult indicating whether changes were applied, no changes needed, or rejected
     */
    abstract disableServers(serverNames: string[], projectPath?: string | null): Promise<WriteResult>;

    /**
     * Get available projects (if provider supports project-level configuration)
     * @returns Array of project paths, or empty array if not supported
     */
    getProjects(): Promise<string[]> {
        // Default implementation returns empty array (no project support)
        return Promise.resolve([]);
    }

    /**
     * Get enabled state per project for all servers.
     * For providers with project support, returns a map of server names to their per-project enabled states.
     * For providers without project support, returns an empty map.
     * @returns Map of server name to per-project enabled states (project path -> boolean)
     */
    async getServerEnabledStatesPerProject(): Promise<Map<string, Record<string, boolean>>> {
        // Default implementation returns empty map (no project support)
        return Promise.resolve(new Map());
    }

    /**
     * Install/add an MCP server configuration
     * @returns WriteResult indicating whether changes were applied, no changes needed, or rejected
     */
    abstract installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult>;

    /**
     * Completely REMOVE servers from this provider's config. Unlike disable,
     * this is permanent — the entries are gone from the provider config (and,
     * when driven by the `remove` command, from the unified config too).
     * @returns WriteResult indicating whether changes were applied, no changes needed, or rejected
     */
    abstract removeServers(serverNames: string[]): Promise<WriteResult>;

    /**
     * Whether a server should be present (installed) in this provider's config
     * given its _meta.enabled state.
     * - The default fits a harness WITH a native disabled state (Gemini's
     *   `mcp.excluded`): disabled servers stay installed and are marked disabled.
     * - Cursor and Codex (presence means enabled) install only enabled servers.
     * - Claude: a globally-disabled server (`_meta.enabled.claude === false`)
     *   must be ABSENT from ~/.claude.json, because absence is the only global
     *   disable Claude Code honors.
     * - Grok decides every table in `syncServers`, so it installs none up front.
     */
    shouldBeInstalled(_serverConfig: UnifiedMCPServerConfig): boolean {
        return true;
    }

    /**
     * Check if a server is enabled for this provider based on _meta.enabled state.
     * For providers with project support, checks if enabled globally or for a specific project.
     * @param serverConfig - Server configuration with _meta
     * @param projectPath - Optional project path to check (for providers with project support)
     * @returns true if enabled, false otherwise
     */
    isServerEnabledInMeta(serverConfig: UnifiedMCPServerConfig, projectPath?: string | null): boolean {
        const providerName = this.providerName;
        const enabledState = serverConfig._meta?.enabled?.[providerName as keyof typeof serverConfig._meta.enabled];

        if (enabledState === undefined) {
            // Not explicitly set - default to disabled
            return false;
        }

        if (typeof enabledState === "boolean") {
            // Simple boolean - global enablement
            return enabledState;
        }

        // Per-project enablement object
        if (projectPath === null || projectPath === undefined) {
            // Check if enabled globally (any project has it enabled, or check for global key)
            // For now, if it's an object, we consider it project-specific and not globally enabled
            return false;
        }

        // Check specific project
        return enabledState[projectPath] === true;
    }

    /**
     * Sync servers from unified config to this provider.
     * Reads _meta.enabled[providerName] to determine enabled state per server.
     * @param servers - Server configurations to sync (with _meta intact)
     * @returns WriteResult indicating whether changes were applied, no changes needed, or rejected
     */
    abstract syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult>;

    /**
     * Convert provider-specific config to unified format
     */
    abstract toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig>;

    /**
     * Apply harness home lists from the unified config.
     * Providers with a single config path ignore this.
     */
    applyHarnessConfig(_config: UnifiedMCPConfig): void {}

    /**
     * MCP servers that an enabled plugin brings into this harness. They never enter the
     * unified config, so `listServers`, `sync` and `sync-from-providers` do not see them.
     * `enabled` is false when this harness's own per-server switch turned the server off.
     */
    async listPluginServers(): Promise<MCPServerInfo[]> {
        return [];
    }

    /**
     * MCP servers this harness loads from ANOTHER harness's config (Grok reads `~/.claude.json`
     * and `~/.cursor/mcp.json`), minus the names its own config or a plugin already defines.
     * Display only: they never enter the unified config, so `sync-from-providers` does not see them.
     */
    async listCompatServers(): Promise<MCPServerInfo[]> {
        return [];
    }

    /**
     * Turn plugin-provided servers off (or back on) with this harness's own switch, keeping
     * the plugin itself enabled. Names this harness has no plugin server for are ignored.
     */
    async setPluginServersEnabled(_serverNames: string[], _enabled: boolean): Promise<WriteResult> {
        return WriteResult.NoChanges;
    }
}
