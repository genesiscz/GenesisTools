import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("mcp-stdio");

/** The part of an MCP SDK `Server` this helper drives, so the helper needs no SDK import. */
export interface StdioServerLike<T> {
    connect(transport: T): Promise<void>;
    close(): Promise<void>;
    onclose?: () => void;
}

export interface ServeStdioOptions<T> {
    name: string;
    server: StdioServerLike<T>;
    transport: T;
    /** Releases what the server owns (a worker child, a native session) before the process exits. */
    shutdown?: () => void | Promise<void>;
    /** The last-resort synchronous cleanup on `process.exit`, for a stop that never ran `shutdown`. */
    onExit?: () => void;
    /** Upper bound for `shutdown`; the process exits after it either way. */
    shutdownTimeoutMs?: number;
}

/** The no-op tool some hosts call when an agent turn ends (Codex's node_repl `turn_ended`). */
export const TURN_ENDED_TOOL = {
    name: "turn_ended",
    description: "Notify the server that an agent turn ended. A no-op kept for compatibility with hosts that send it.",
    inputSchema: {
        type: "object" as const,
        properties: {
            hook_event_name: { type: "string" },
            session_id: { type: "string" },
            turn_id: { type: "string" },
        },
        additionalProperties: true,
    },
    annotations: { idempotentHint: true },
};

/**
 * Serves an MCP server on stdio and stops it once, whichever comes first: the transport closes, the host closes
 * stdin (the stdio transport does not turn an ended stdin into onclose), or SIGINT/SIGTERM. A second signal while
 * stopping is ignored rather than killing the process mid-cleanup, because `./tools` forwards every Ctrl-C.
 */
export async function serveStdio<T>(
    options: ServeStdioOptions<T>
): Promise<{ stop: (reason: string) => Promise<void> }> {
    const { server, name } = options;
    let stopping: Promise<void> | undefined;
    const stop = (reason: string): Promise<void> => {
        stopping ??= (async () => {
            log.info({ server: name, reason }, "MCP server stopping");

            try {
                await Promise.race([
                    Promise.resolve(options.shutdown?.()),
                    Bun.sleep(options.shutdownTimeoutMs ?? 5_000),
                ]);
            } catch (error) {
                log.warn({ error, server: name }, "MCP server shutdown failed");
            }

            process.exit(0);
        })();
        return stopping;
    };
    const previousClose = server.onclose;
    server.onclose = () => {
        previousClose?.();
        void stop("transport closed");
    };
    process.stdin.once("end", () => void stop("stdin ended"));
    process.on("SIGINT", () => void stop("SIGINT"));
    process.on("SIGTERM", () => void stop("SIGTERM"));

    if (options.onExit) {
        process.on("exit", options.onExit);
    }

    await server.connect(options.transport);
    log.info({ server: name }, "MCP server listening on stdio");
    return { stop };
}
