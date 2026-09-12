import { Buffer } from "node:buffer";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GATEWAY_HEADER } from "../auth/constants.ts";

export function encodeStdioMessage(json: string): Buffer {
    return Buffer.from(`${compactJsonRpc(json)}\n`, "utf8");
}

export function parseStdioMessages(buffer: Buffer): { messages: string[]; rest: Buffer } {
    const messages: string[] = [];
    let offset = 0;

    while (true) {
        const nl = buffer.indexOf(0x0a, offset);

        if (nl < 0) {
            break;
        }

        let line = buffer.subarray(offset, nl);

        if (line.length > 0 && line[line.length - 1] === 0x0d) {
            line = line.subarray(0, line.length - 1);
        }

        const text = line.toString("utf8").trim();

        if (text.length > 0) {
            messages.push(text);
        }

        offset = nl + 1;
    }

    return { messages, rest: Buffer.from(buffer.subarray(offset)) };
}

export function compactJsonRpc(text: string): string {
    try {
        return SafeJSON.stringify(SafeJSON.parse(text, { strict: true }), { strict: true });
    } catch {
        return text.trim();
    }
}

export async function jsonRpcBodiesFromHttp(response: Response): Promise<string[]> {
    const type = response.headers.get("content-type") ?? "";
    const text = await response.text();

    if (!type.includes("text/event-stream")) {
        const trimmed = text.trim();

        return trimmed.length > 0 ? [compactJsonRpc(trimmed)] : [];
    }

    return text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => compactJsonRpc(line.slice(5).trim()))
        .filter((line) => line.length > 0);
}

function requestIdFromMessage(message: string): unknown {
    try {
        const parsed = SafeJSON.parse(message, { strict: true });

        if (parsed && typeof parsed === "object" && "id" in parsed) {
            return (parsed as { id: unknown }).id;
        }
    } catch (error) {
        logger.debug({ error }, "stdio relay could not read jsonrpc id");
    }

    return null;
}

function jsonRpcErrorLine(id: unknown, message: string): string {
    return SafeJSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }, { strict: true });
}

function looksLikeJsonRpc(text: string): boolean {
    try {
        const parsed = SafeJSON.parse(text, { strict: true });

        return Boolean(parsed && typeof parsed === "object" && "jsonrpc" in parsed);
    } catch {
        return false;
    }
}

export async function runStdioHttpRelay(opts: {
    url: string;
    headers: Record<string, string>;
    stdin: AsyncIterable<Uint8Array>;
    stdout: { write(chunk: Uint8Array): unknown };
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    let pending: Buffer = Buffer.alloc(0);
    let sessionId: string | undefined;

    for await (const chunk of opts.stdin) {
        pending = Buffer.from(Buffer.concat([pending, Buffer.from(chunk)]));
        const parsed = parseStdioMessages(pending);
        pending = Buffer.from(parsed.rest);

        for (const message of parsed.messages) {
            const headers: Record<string, string> = {
                Accept: "application/json, text/event-stream",
                "Content-Type": "application/json",
                [GATEWAY_HEADER]: opts.headers[GATEWAY_HEADER] ?? "",
                ...opts.headers,
            };

            if (sessionId) {
                headers["mcp-session-id"] = sessionId;
            }

            const response = await fetchImpl(opts.url, {
                method: "POST",
                headers,
                body: message,
            });
            const returnedSession = response.headers.get("mcp-session-id");

            if (returnedSession) {
                sessionId = returnedSession;
            }

            if (response.status === 404) {
                sessionId = undefined;
            }

            if (response.status === 202 || response.status === 204) {
                await response.arrayBuffer();
                continue;
            }

            if (!response.ok) {
                const status = response.status;
                const text = await response.text();
                logger.warn({ status, url: opts.url }, "stdio relay upstream HTTP error");

                if (looksLikeJsonRpc(text)) {
                    opts.stdout.write(encodeStdioMessage(text));
                    continue;
                }

                opts.stdout.write(
                    encodeStdioMessage(jsonRpcErrorLine(requestIdFromMessage(message), `gateway HTTP ${status}`))
                );
                continue;
            }

            const bodies = await jsonRpcBodiesFromHttp(response);

            for (const body of bodies) {
                opts.stdout.write(encodeStdioMessage(body));
            }
        }
    }
}
