/**
 * The server registry.
 *
 * Source of truth is mcp-manager's provider scan — imported directly via
 * `buildListJson(defaultProviders())`, not spawned as a subprocess. mcp-manager
 * already reconciles Claude global vs per-project scope, Gemini, Cursor and
 * Codex into one view with a resolved enabled state, which is the harder half
 * of the problem. Those definitions are then handed to mcporter via
 * `createRuntime({ servers })`, so mcporter handles transport, connection
 * caching and OAuth while never reading a config file of its own.
 *
 * The disk cache exists because a provider scan reads every editor's config
 * file, and a persisted script may load the registry on every run.
 */
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import {
    buildListJson,
    type ListJsonOutput,
    type ServerConnection,
    type ServerJsonEntry,
} from "@app/mcp-manager/commands/list";
import { defaultProviders } from "@app/mcp-manager/utils/providers/index.js";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import type { ServerDefinition } from "mcporter";
import { authFor } from "./claude-tokens.ts";
import { cacheDir } from "./store.ts";

export type { ServerConnection, ServerJsonEntry };

export interface Registry extends ListJsonOutput {
    fetchedAt: string;
}

export interface ToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
}

export interface ToolCacheEntry {
    server: string;
    fetchedAt: string;
    tools: ToolInfo[];
    error?: string;
}

function registryCachePath(): string {
    return join(cacheDir(), "registry.json");
}

function toolsCachePath(): string {
    return join(cacheDir(), "tools.json");
}

async function readJson<T>(path: string): Promise<T | undefined> {
    try {
        return SafeJSON.parse(await Bun.file(path).text(), { strict: true }) as T;
    } catch (error) {
        logger.debug({ path, error }, "cache read miss");
        return undefined;
    }
}

/**
 * Caches are written atomically and mode 0600: the registry carries each
 * connection's `env` and `headers`, which routinely hold API keys, so the
 * cache must never be world-readable, even between write and chmod.
 */
function writeJson(path: string, value: unknown): void {
    atomicWriteFileSync(path, `${SafeJSON.stringify(value, { strict: true }, 2)}\n`, { mode: 0o600 });
}

export interface LoadRegistryOptions {
    /** Re-scan the provider configs instead of reading the cache. */
    refresh?: boolean;
    /** Skip the cache write. Diagnostics (`doctor`) and `--dry-run` paths must not mutate durable state. */
    persist?: boolean;
}

/**
 * A cache written before the 0600 hardening stays world-readable forever on
 * the hit path; tighten it in place. Returns false when the permissions could
 * NOT be verified or tightened — the caller must then ignore the cache and
 * rebuild it (the rebuild writes 0600 atomically), rather than silently
 * consuming a credential file whose exposure it could not close.
 */
async function repairCacheMode(path: string): Promise<boolean> {
    try {
        const info = await stat(path);

        if ((info.mode & 0o077) !== 0) {
            await chmod(path, 0o600);
            logger.info({ path }, "tightened credential cache permissions to 0600");
        }

        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            logger.debug({ path, error }, "cache vanished during permission check");
        } else {
            logger.warn({ path, error }, "cannot verify credential cache permissions — ignoring cache, rebuilding");
        }

        return false;
    }
}

/** Load the registry. Cached on disk; `refresh` re-scans the providers. */
export async function loadRegistry(options: LoadRegistryOptions = {}): Promise<Registry> {
    if (!options.refresh) {
        const cached = await readJson<Registry>(registryCachePath());

        // An empty servers array is a valid cached result (the ListJsonOutput
        // contract says so); requiring length would rescan every provider on
        // every command on a machine with no MCP servers.
        if (cached && Array.isArray(cached.servers)) {
            // Permission repair is a mutation, so the read-only (`persist:
            // false`) path reports it via doctor instead of doing it. On the
            // normal path an unverifiable cache is treated as a miss.
            if (options.persist === false || (await repairCacheMode(registryCachePath()))) {
                return cached;
            }
        }
    }

    const payload = await buildListJson(defaultProviders());
    const registry: Registry = { ...payload, fetchedAt: new Date().toISOString() };

    if (options.persist !== false) {
        writeJson(registryCachePath(), registry);
    }

    logger.debug(
        {
            servers: registry.servers.length,
            failed: registry.providersFailed.length,
            persisted: options.persist !== false,
        },
        "scripts registry refreshed"
    );
    return registry;
}

/** Servers that at least one provider has enabled, i.e. the ones worth connecting to. */
export function enabledServers(registry: Registry): ServerJsonEntry[] {
    return registry.servers.filter((s) => s.enabled && s.connection.type !== "unknown");
}

/**
 * Map a registry entry to an mcporter ServerDefinition.
 *
 * `env` is passed through as overrides; mcporter merges over process.env, which
 * stdio servers rely on for PATH and HOME.
 */
export function toServerDefinition(
    server: ServerJsonEntry,
    extraHeaders?: Record<string, string>
): ServerDefinition | undefined {
    const c = server.connection;

    if (c.type === "stdio" && c.command) {
        return {
            name: server.name,
            command: { kind: "stdio", command: c.command, args: c.args ?? [], cwd: process.cwd() },
            env: c.env,
        };
    }

    if ((c.type === "http" || c.type === "sse") && c.url) {
        let url: URL;

        try {
            url = new URL(c.url);
        } catch (error) {
            // The url is user-authored editor config; one bad entry must not
            // abort the whole definition build.
            logger.warn({ server: server.name, url: c.url, error }, "skipping server with unparsable url");
            return undefined;
        }

        return {
            name: server.name,
            command: { kind: "http", url, headers: { ...c.headers, ...extraHeaders } },
        };
    }

    return undefined;
}

/** Servers whose stored token has a problem, reported so the CLI can say so once. */
export interface AuthProblem {
    server: string;
    problem: string;
}

/**
 * Build mcporter definitions, attaching Claude Code's Bearer token to every
 * remote server it holds one for. Scripts are headless, so a remote server
 * without a header cannot authenticate at all.
 */
export async function toServerDefinitions(
    registry: Registry,
    names?: string[],
    options: { refreshAuth?: boolean } = {}
): Promise<{ definitions: ServerDefinition[]; authProblems: AuthProblem[] }> {
    const wanted = names && names.length > 0 ? new Set(names) : undefined;
    const selected = enabledServers(registry).filter((s) => !wanted || wanted.has(s.name));
    const definitions: ServerDefinition[] = [];
    const authProblems: AuthProblem[] = [];

    for (const server of selected) {
        let headers: Record<string, string> | undefined;

        if (server.connection.url) {
            const auth = await authFor(server.connection.url, { refresh: options.refreshAuth });
            headers = auth.headers;

            const note = auth.problem ?? auth.missing;

            if (note) {
                authProblems.push({ server: server.name, problem: note });
            }
        }

        const definition = toServerDefinition(server, headers);

        if (definition) {
            definitions.push(definition);
        }
    }

    return { definitions, authProblems };
}

export async function loadToolCache(): Promise<Record<string, ToolCacheEntry>> {
    return (await readJson<Record<string, ToolCacheEntry>>(toolsCachePath())) ?? {};
}

export async function saveToolCache(cache: Record<string, ToolCacheEntry>): Promise<void> {
    writeJson(toolsCachePath(), cache);
}
