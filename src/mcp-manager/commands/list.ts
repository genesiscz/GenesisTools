import type { MCPProvider, MCPServerInfo, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { logger, out } from "@genesiscz/utils/logger";
import chalk from "chalk";

/**
 * Options for {@link listServers}. `json` switches the output MODE, not just the
 * formatting: the human listing is skipped entirely and the payload is written to
 * stdout through `out.result`, so the command stays pipeable.
 */
export interface ListOptions {
    /** Emit machine-readable JSON on stdout instead of the human listing. */
    json?: boolean;
    /** With --json, only include servers enabled in at least one provider. */
    enabledOnly?: boolean;
}

/** One provider's view of a server. */
export interface ServerProviderEntry {
    provider: string;
    enabled: boolean;
}

/** Transport-resolved connection details, flattened for programmatic clients. */
export interface ServerConnection {
    type: "stdio" | "http" | "sse" | "unknown";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
}

/**
 * One server in the `--json` payload.
 *
 * The same server name can be registered in several providers at once, so
 * enablement is reported twice over: `providers` keeps the per-provider truth,
 * while `enabled` and `status` summarise it for callers that do not care which
 * provider supplied the entry.
 */
export interface ServerJsonEntry {
    /** Name the server is registered under, unique across the payload. */
    name: string;
    /** True when at least one provider has this server enabled. */
    enabled: boolean;
    /**
     * Rollup of `providers`: `enabled` when every provider listing this server
     * has it turned on, `disabled` when none do, `partial` when they disagree
     * (typically a server enabled for one editor but not another).
     */
    status: "enabled" | "partial" | "disabled";
    /** Per-provider enablement, one entry per provider that lists this server. */
    providers: ServerProviderEntry[];
    /** Transport details taken from the winning config (see {@link pickConfig}). */
    connection: ServerConnection;
}

/**
 * Payload of `tools mcp-manager list --json`.
 *
 * This is a consumed contract rather than a debug dump: the mcp-scripting skill
 * builds mcporter ServerDefinitions straight from `servers[].connection`. Treat
 * the field names as public, and prefer adding fields over renaming them.
 *
 * A provider absent from BOTH `providersScanned` and `providersFailed` simply had
 * no config file on disk, which is why an empty `servers` array is a valid result
 * and not an error.
 */
export interface ListJsonOutput {
    /** Every server found, sorted by name. Empty when no provider listed any. */
    servers: ServerJsonEntry[];
    /** Providers whose config file existed and was read. */
    providersScanned: string[];
    /** Providers that threw while being read, with the reason. */
    providersFailed: { provider: string; error: string }[];
}

/**
 * Flatten a unified server config into the transport shape a programmatic MCP
 * client needs. `_meta` is intentionally dropped: it is mcp-manager bookkeeping,
 * not connection data.
 */
function toConnection(config: UnifiedMCPServerConfig | undefined): ServerConnection {
    if (!config) {
        return { type: "unknown" };
    }

    const url =
        typeof config.url === "string" ? config.url : typeof config.httpUrl === "string" ? config.httpUrl : undefined;
    const command = typeof config.command === "string" ? config.command : undefined;

    let type: ServerConnection["type"] = "unknown";
    if (config.type === "stdio" || config.type === "http" || config.type === "sse") {
        type = config.type;
    } else if (command) {
        type = "stdio";
    } else if (url) {
        type = "http";
    }

    const args = Array.isArray(config.args) ? config.args.map((a) => String(a)) : undefined;

    return {
        type,
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(url ? { url } : {}),
        ...(config.headers ? { headers: config.headers } : {}),
    };
}

/**
 * Pick the config to report for a server seen in several providers. An enabled
 * instance wins, because a disabled provider entry can be a stale leftover.
 */
function pickConfig(instances: MCPServerInfo[]): UnifiedMCPServerConfig | undefined {
    const enabled = instances.find((i) => i.enabled && (i.config?.command || i.config?.url || i.config?.httpUrl));
    if (enabled) {
        return enabled.config;
    }

    return (
        instances.find((i) => i.config?.command || i.config?.url || i.config?.httpUrl)?.config ?? instances[0]?.config
    );
}

async function collect(providers: MCPProvider[]): Promise<{
    byName: Map<string, MCPServerInfo[]>;
    scanned: string[];
    failed: { provider: string; error: string }[];
}> {
    const allServers: MCPServerInfo[] = [];
    const scanned: string[] = [];
    const failed: { provider: string; error: string }[] = [];

    for (const provider of providers) {
        try {
            if (await provider.configExists()) {
                const servers = await provider.listServers();
                allServers.push(...servers);
                scanned.push(provider.getName());
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push({ provider: provider.getName(), error: message });
            logger.warn(`Failed to read ${provider.getName()} config: ${message}`);
        }
    }

    const byName = new Map<string, MCPServerInfo[]>();
    for (const server of allServers) {
        if (!byName.has(server.name)) {
            byName.set(server.name, []);
        }

        byName.get(server.name)?.push(server);
    }

    return { byName, scanned, failed };
}

/**
 * Build the registry payload of `list --json` without printing it. This is the
 * programmatic entrypoint `tools scripts` consumes to construct mcporter
 * ServerDefinitions in-process instead of spawning `tools mcp-manager`.
 */
export async function buildListJson(providers: MCPProvider[], options: ListOptions = {}): Promise<ListJsonOutput> {
    const { byName, scanned, failed } = await collect(providers);
    const servers: ServerJsonEntry[] = [];

    for (const [name, instances] of byName.entries()) {
        const enabledCount = instances.filter((s) => s.enabled).length;
        const status = enabledCount === instances.length ? "enabled" : enabledCount > 0 ? "partial" : "disabled";

        if (options.enabledOnly && enabledCount === 0) {
            continue;
        }

        servers.push({
            name,
            enabled: enabledCount > 0,
            status,
            providers: instances.map((i) => ({ provider: i.provider, enabled: i.enabled })),
            connection: toConnection(pickConfig(instances)),
        });
    }

    servers.sort((a, b) => a.name.localeCompare(b.name));
    return { servers, providersScanned: scanned, providersFailed: failed };
}

/**
 * List all MCP servers across all providers.
 *
 * With `--json` this becomes the programmatic registry other tools read (the
 * mcp-scripting skill builds mcporter ServerDefinitions straight from it), so
 * the JSON carries connection details the human listing never printed.
 */
export async function listServers(providers: MCPProvider[], options: ListOptions = {}): Promise<void> {
    if (options.json) {
        const payload = await buildListJson(providers, options);
        logger.debug(
            { count: payload.servers.length, scanned: payload.providersScanned, failed: payload.providersFailed },
            "mcp-manager list --json"
        );
        out.result(payload);
        return;
    }

    const { byName } = await collect(providers);

    if (byName.size === 0) {
        logger.info("No MCP servers found.");
        return;
    }

    logger.info("\nMCP Servers:\n");
    for (const [name, instances] of byName.entries()) {
        const enabledCount = instances.filter((s) => s.enabled).length;
        const status = enabledCount === instances.length ? "✓" : enabledCount > 0 ? "⚠" : "✗";
        const statusText = enabledCount === instances.length ? "enabled" : enabledCount > 0 ? "partial" : "disabled";

        logger.info(`${status} ${chalk.bold(name)} (${statusText} in ${instances.length} provider(s))`);
        for (const instance of instances) {
            let providerStatus = instance.enabled ? chalk.green("enabled") : chalk.red("disabled");

            // Claude: a globally-disabled server can be re-enabled per project
            // via a project-scope override entry — surface that on the global row.
            if (!instance.enabled && instance.provider === "claude") {
                const overrideCount = instances.filter((s) => s.provider.startsWith("claude:") && s.enabled).length;
                if (overrideCount > 0) {
                    providerStatus = chalk.yellow(`disabled globally, enabled in ${overrideCount} project(s)`);
                }
            }

            logger.info(`  └─ ${instance.provider}: ${providerStatus}`);
        }

        logger.info("");
    }
}
