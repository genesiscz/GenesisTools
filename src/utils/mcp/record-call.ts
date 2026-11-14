import { recordHandledFailure } from "@genesiscz/utils/cli/failures/handled";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import type { CallToolResult } from "@modelcontextprotocol/server";

interface PendingCall {
    name: string;
    started: number;
}

function failureText(response: unknown): string | null {
    if (!isObject(response)) {
        return null;
    }

    if (isObject(response.error)) {
        return typeof response.error.message === "string" ? response.error.message : "MCP protocol error";
    }

    const result = isObject(response.result) ? response.result : response;
    if (result.isError !== true) {
        return null;
    }

    return Array.isArray(result.content)
        ? result.content
              .flatMap((item: unknown) =>
                  isObject(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []
              )
              .join("\n")
        : "MCP tool call failed";
}

function outcome(options: {
    server: string;
    call: PendingCall;
    message: string | null;
    record: typeof recordHandledFailure;
}): void {
    const durationMs = performance.now() - options.call.started;
    if (options.message !== null) {
        options.record({
            tool: options.server,
            call: options.call.name,
            error: new Error(options.message),
            durationMs,
        });
    }

    logger.debug(
        { server: options.server, tool: options.call.name, ok: options.message === null, durationMs },
        "MCP call ended"
    );
}

/** For HTTP/embedded servers. The caller's request context surrounds this boundary, so attribution stays correct. */
export async function recordMcpCall(options: {
    server: string;
    name: string;
    run: () => Promise<CallToolResult>;
    record?: typeof recordHandledFailure;
}): Promise<CallToolResult> {
    const call = { name: options.name, started: performance.now() };
    const record = options.record ?? recordHandledFailure;
    logger.debug({ server: options.server, tool: options.name }, "MCP call started");
    try {
        const answer = await options.run();
        outcome({ server: options.server, call, message: failureText(answer), record });
        return answer;
    } catch (error) {
        record({ tool: options.server, call: options.name, error, durationMs: performance.now() - call.started });
        throw error;
    }
}

/** Instrument the common stdio boundary, including older servers with custom tool handlers. No request arguments
 * are retained. The SDK's transport methods, callbacks and exact protocol messages pass through unchanged. */
export function recordMcpTransport<T>(options: {
    transport: T;
    server: string;
    record?: typeof recordHandledFailure;
}): T {
    const { transport, server } = options;
    if (typeof transport !== "object" || transport === null) {
        return transport;
    }

    const pending = new Map<string | number, PendingCall>();
    const record = options.record ?? recordHandledFailure;
    return new Proxy(transport, {
        get(target, key) {
            const value: unknown = Reflect.get(target, key, target);
            if (key === "send" && typeof value === "function") {
                return async (...args: unknown[]) => {
                    const message = args[0];
                    if (isObject(message) && (typeof message.id === "string" || typeof message.id === "number")) {
                        const call = pending.get(message.id);
                        if (call) {
                            pending.delete(message.id);
                            outcome({ server, call, message: failureText(message), record });
                        }
                    }

                    return Reflect.apply(value, target, args);
                };
            }

            if (key === "close" && typeof value === "function") {
                return (...args: unknown[]) => {
                    pending.clear();
                    return Reflect.apply(value, target, args);
                };
            }

            return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, key, value: unknown) {
            if (key === "onmessage" && typeof value === "function") {
                return Reflect.set(target, key, (...args: unknown[]) => {
                    const message = args[0];
                    if (
                        isObject(message) &&
                        message.method === "tools/call" &&
                        (typeof message.id === "string" || typeof message.id === "number")
                    ) {
                        const name =
                            isObject(message.params) && typeof message.params.name === "string"
                                ? message.params.name
                                : "tools/call";
                        pending.set(message.id, { name, started: performance.now() });
                        logger.debug({ server, tool: name }, "MCP call started");
                    }

                    return Reflect.apply(value, target, args);
                });
            }

            return Reflect.set(target, key, value);
        },
    });
}
