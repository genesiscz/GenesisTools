/**
 * Tool discovery: resolve selectors against the registry, probing ONLY the
 * servers a selector can reach. This is the difference between spawning one
 * stdio server and spawning all thirty.
 */
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { createKit } from "./kit.ts";
import { globMatch, matchesSelector, parseSelector, type Selector } from "./match.ts";
import {
    enabledServers,
    loadRegistry,
    loadToolCache,
    type Registry,
    saveToolCache,
    type ToolInfo,
} from "./registry.ts";
import { schemaToType } from "./schema-ts.ts";

export interface ParamInfo {
    name: string;
    type: string;
    required: boolean;
    desc?: string;
}

/** Flatten a tool's inputSchema into a parameter list. */
export function paramsOf(schema: unknown): ParamInfo[] {
    const s = schema as { properties?: Record<string, unknown>; required?: unknown } | null;

    if (!s || typeof s !== "object" || !s.properties) {
        return [];
    }

    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);

    return Object.entries(s.properties).map(([name, raw]) => {
        const p = raw as { description?: unknown };

        return {
            name,
            type: schemaToTypeShort(raw),
            required: required.has(name),
            desc: typeof p?.description === "string" ? p.description : undefined,
        };
    });
}

function schemaToTypeShort(schema: unknown): string {
    return schemaToType(schema).replace(/\s+/g, " ");
}

/** `name(req: string, opt?: number)` — the shape you need before writing a call. */
export function signatureOf(name: string, schema: unknown, maxTypeLen = 28): string {
    const params = paramsOf(schema);

    if (params.length === 0) {
        return `${name}()`;
    }

    const inner = params
        .map((p) => {
            const type = p.type.length > maxTypeLen ? `${p.type.slice(0, maxTypeLen - 1)}…` : p.type;

            return `${p.name}${p.required ? "" : "?"}: ${type}`;
        })
        .join(", ");

    return `${name}(${inner})`;
}

export function firstLine(s: string | undefined, max: number): string {
    const line =
        (s ?? "")
            .split("\n")
            .find((l) => l.trim().length > 0)
            ?.trim() ?? "";

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface DiscoveredTool {
    server: string;
    tool: ToolInfo;
}

export interface DiscoverResult {
    found: DiscoveredTool[];
    errors: { server: string; error: string }[];
}

export interface DiscoverOptions {
    /** Re-probe servers instead of using the tool cache. */
    refresh?: boolean;
    /** Skip cache writes. `--dry-run` promises "write nothing", which includes caches. */
    persist?: boolean;
}

/**
 * List tools for the given servers, caching per server.
 *
 * Uncached servers cost a real stdio spawn plus an initialize handshake, so a
 * broad selector like `*.*` is genuinely slow the first time and instant after.
 * A server that fails to start is cached as an error so one broken entry does
 * not re-block every later run.
 */
export async function discoverTools(servers: string[], options: DiscoverOptions = {}): Promise<DiscoverResult> {
    const cache = await loadToolCache();
    const stale = options.refresh ? servers : servers.filter((s) => !cache[s]);
    const errors: { server: string; error: string }[] = [];

    if (stale.length > 0) {
        ui.dim(`probing ${stale.length} server(s): ${stale.join(", ")}`);
        logger.debug({ stale, persist: options.persist !== false }, "probing mcp servers");
        const kit = await createKit({ servers: stale, refresh: options.refresh, persist: options.persist });

        try {
            await Promise.all(
                stale.map(async (server) => {
                    try {
                        const tools = await kit.listTools(server, { includeSchema: true });
                        cache[server] = {
                            server,
                            fetchedAt: new Date().toISOString(),
                            tools: tools.map((t) => ({
                                name: t.name,
                                description: t.description,
                                inputSchema: t.inputSchema,
                                outputSchema: t.outputSchema,
                            })),
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        logger.debug({ server, error }, "server probe failed");
                        cache[server] = { server, fetchedAt: new Date().toISOString(), tools: [], error: message };
                    }
                })
            );
        } finally {
            await kit.close();
        }

        if (options.persist !== false) {
            await saveToolCache(cache);
        }
    }

    const found: DiscoveredTool[] = [];

    for (const server of servers) {
        const entry = cache[server];

        if (!entry) {
            continue;
        }

        if (entry.error) {
            errors.push({ server, error: entry.error });
        }

        for (const tool of entry.tools) {
            found.push({ server, tool });
        }
    }

    return { found, errors };
}

export interface ResolvedSelectors extends DiscoverResult {
    registry: Registry;
    available: string[];
    parsed: Selector[];
    matched: DiscoveredTool[];
}

/**
 * Safety guard for `regen`: a transient probe failure on a previously bound
 * server must not silently strip that server's tools from the bindings and
 * journal. Throws unless `force` opts into the loss.
 */
export function assertBoundServersResponded(
    previousServers: string[],
    errors: DiscoverResult["errors"],
    force: boolean
): void {
    const failedBound = errors.filter((e) => previousServers.includes(e.server));

    if (failedBound.length > 0 && !force) {
        throw new Error(
            `${failedBound.map((e) => e.server).join(", ")} did not respond, so their bindings would be dropped. ` +
                "Fix the server(s) and retry, or pass --force to accept the loss."
        );
    }
}

/** Resolve selectors, probing only the servers they can reach. */
export async function resolveSelectors(selectors: string[], options: DiscoverOptions = {}): Promise<ResolvedSelectors> {
    const registry = await loadRegistry({ refresh: options.refresh, persist: options.persist });
    const available = enabledServers(registry).map((s) => s.name);
    const parsed = selectors.map((s) => parseSelector(s, available));
    const serversToProbe = available.filter((server) => parsed.some((p) => globMatch(p.server, server)));

    if (serversToProbe.length === 0) {
        return { registry, available, parsed, matched: [], found: [], errors: [] };
    }

    const { found, errors } = await discoverTools(serversToProbe, options);
    const matched = found.filter(({ server, tool }) => parsed.some((p) => matchesSelector(p, server, tool.name)));

    return { registry, available, parsed, matched, found, errors };
}
