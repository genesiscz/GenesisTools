/**
 * The runtime a persisted script actually imports (`@gt/scripts/kit`).
 *
 * Everything here is deliberately non-agentic: no LLM, no tool-choice loop.
 * You call tools in the order you wrote, in plain control flow.
 *
 *   import { withKit, text } from "@gt/scripts/kit";
 *
 *   await withKit(async (kit) => {
 *     const pages = await kit.call("chrome-devtools-mcp", "list_pages");
 *     console.log(text(pages));
 *   });
 *
 * Concurrency note: MCP removed JSON-RPC batching in the 2025-06-18 spec
 * revision, so there is no way to send N calls as one payload. `kit.all()`
 * fires them concurrently over the already-open session instead, which is the
 * only lever left.
 */
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import {
    type CallResult,
    createCallResult,
    createRuntime,
    type ImageContent,
    type Runtime,
    type RuntimeLogger,
    type ServerDefinition,
    type ServerToolInfo,
} from "mcporter";
import { parseSelector } from "./match.ts";
import { loadRegistry, type Registry, toServerDefinitions } from "./registry.ts";

export interface KitOptions {
    /** Restrict the runtime to these servers. Default: every enabled server. */
    servers?: string[];
    /** Re-read the registry from the provider configs instead of the cache. */
    refresh?: boolean;
    /** Skip registry cache writes; dry-run and diagnostic callers must not mutate durable state. */
    persist?: boolean;
    /** Never start an interactive OAuth flow. Default true: scripts are headless. */
    disableOAuth?: boolean;
    /** Per-call timeout in ms. Default 120s, since browser and search tools are slow. */
    timeoutMs?: number;
}

export interface Kit {
    runtime: Runtime;
    registry: Registry;
    definitions: ServerDefinition[];
    /** Names of servers this kit can reach. */
    servers(): string[];
    listTools(server: string, options?: { includeSchema?: boolean }): Promise<ServerToolInfo[]>;
    /** Call one tool. Throws on transport failure; MCP `isError` results come back as data. */
    call(server: string, tool: string, args?: Record<string, unknown>): Promise<unknown>;
    /** Call `<server>.<tool>` in one string. */
    callRef(ref: string, args?: Record<string, unknown>): Promise<unknown>;
    /** Run calls concurrently over the open session. */
    all<T>(tasks: (() => Promise<T>)[]): Promise<T[]>;
    close(): Promise<void>;
}

/**
 * Silences mcporter's routine chatter so script stdout stays clean and
 * pipeable; warnings and errors go through the shared logger (day-log always,
 * console per level).
 */
const quietLogger: RuntimeLogger = {
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => logger.warn({ mcporter: a }, "mcporter warning"),
    error: (...a: unknown[]) => logger.error({ mcporter: a }, "mcporter error"),
};

export async function createKit(options: KitOptions = {}): Promise<Kit> {
    const registry = await loadRegistry({ refresh: options.refresh, persist: options.persist });
    const { definitions, authProblems } = await toServerDefinitions(registry, options.servers, {
        refreshAuth: options.refresh,
    });

    // A stale token surfaces downstream as a 405 from the legacy SSE fallback,
    // which reads like a transport bug. Say the real thing once, up front, on
    // stderr where a headless script's user actually sees it.
    for (const problem of authProblems) {
        ui.warn(`[auth] ${problem.server}: ${problem.problem}`);
    }

    if (definitions.length === 0) {
        const asked = options.servers?.join(", ");
        throw new Error(
            asked
                ? `No enabled MCP server matched: ${asked}. Run 'tools scripts servers' to see what exists.`
                : "No enabled MCP servers found. Run 'tools scripts servers --refresh'."
        );
    }

    const runtime = await createRuntime({
        servers: definitions,
        clientInfo: { name: "genesis-tools-scripts", version: "0.1.0" },
        logger: quietLogger as never,
    });

    const disableOAuth = options.disableOAuth ?? true;
    const timeoutMs = options.timeoutMs ?? 120_000;

    return {
        runtime,
        registry,
        definitions,
        servers: () => definitions.map((d) => d.name),
        listTools: (server, opts) =>
            runtime.listTools(server, { includeSchema: opts?.includeSchema ?? true, disableOAuth }),
        call: (server, tool, args) => runtime.callTool(server, tool, { args, disableOAuth, timeoutMs }),
        callRef: (ref, args) => {
            const known = definitions.map((d) => d.name);
            const selector = parseSelector(ref, known);

            if (!known.includes(selector.server)) {
                throw new Error(`Unknown server in ref '${ref}'. Known: ${known.join(", ")}`);
            }

            if (selector.tool === "*" || selector.tool.includes("*")) {
                throw new Error(`Ref '${ref}' must name exactly one tool, not a pattern`);
            }

            return runtime.callTool(selector.server, selector.tool, { args, disableOAuth, timeoutMs });
        },
        all: (tasks) => Promise.all(tasks.map((t) => t())),
        close: () => runtime.close(),
    };
}

/** Creates a kit, runs fn, always closes. Use this, not createKit, in scripts. */
export async function withKit<T>(fn: (kit: Kit) => Promise<T>, options: KitOptions = {}): Promise<T> {
    const kit = await createKit(options);

    try {
        return await fn(kit);
    } finally {
        await kit.close();
    }
}

/**
 * Result helpers.
 *
 * These delegate to mcporter's own `createCallResult`, which already knows how
 * to walk the content-block envelope (text, markdown, json, images,
 * structuredContent). We only adapt the return types: mcporter returns
 * `string | null`, and a script reads better with `""` / `undefined`.
 */

/** The full mcporter CallResult, when you want `.markdown()` or `.content()`. */
export function result<T = unknown>(raw: T): CallResult<T> {
    return createCallResult(raw);
}

/** Concatenated text blocks of a tool result. The usual thing you want. */
export function text(raw: unknown): string {
    return createCallResult(raw).text() ?? "";
}

/**
 * `structuredContent` when the server declared an outputSchema, otherwise the
 * text parsed as JSON, otherwise undefined. Servers vary in which they populate.
 */
export function data<T = unknown>(raw: unknown): T | undefined {
    const wrapped = createCallResult(raw);
    const structured = wrapped.structuredContent();

    if (structured !== undefined && structured !== null) {
        return structured as T;
    }

    return (wrapped.json<T>() ?? undefined) as T | undefined;
}

/** Base64 image blocks, e.g. from a screenshot tool. Empty when there are none. */
export function images(raw: unknown): ImageContent[] {
    return createCallResult(raw).images() ?? [];
}

/** True when the server flagged the call as failed. Transport errors throw instead. */
export function isError(raw: unknown): boolean {
    return (raw as { isError?: boolean } | null)?.isError === true;
}

/** Throws if the tool reported an error, otherwise returns the result unchanged. */
export function must<T>(value: T, label = "tool call"): T {
    if (isError(value)) {
        throw new Error(`${label} failed: ${text(value).slice(0, 500)}`);
    }

    return value;
}
