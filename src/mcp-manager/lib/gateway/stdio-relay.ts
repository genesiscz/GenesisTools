import { Buffer } from "node:buffer";
import { SafeJSON } from "@genesiscz/utils/json";
import { GATEWAY_HEADER } from "../auth/constants.ts";

export function encodeStdioMessage(json: string): Buffer {
    return Buffer.from(`${compactJsonRpc(json)}\n`, "utf8");
}

export function parseStdioMessages(buffer: Buffer): { messages: string[]; rest: Buffer } {
    const text = buffer.toString("utf8");
    const lastNl = text.lastIndexOf("\n");

    if (lastNl < 0) {
        return { messages: [], rest: buffer };
    }

    const complete = text.slice(0, lastNl);
    const restText = text.slice(lastNl + 1);
    const messages = complete
        .split("\n")
        .map((line) => line.replace(/\r$/, "").trim())
        .filter((line) => line.length > 0);

    return { messages, rest: Buffer.from(restText, "utf8") };
}

export function compactJsonRpc(text: string): string {
    try {
        return SafeJSON.stringify(SafeJSON.parse(text, { strict: true }));
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

export async function runStdioHttpRelay(opts: {
    url: string;
    headers: Record<string, string>;
    stdin: AsyncIterable<Uint8Array>;
    stdout: { write(chunk: Uint8Array): unknown };
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    let pending: Buffer = Buffer.alloc(0);

    for await (const chunk of opts.stdin) {
        pending = Buffer.from(Buffer.concat([pending, Buffer.from(chunk)]));
        const parsed = parseStdioMessages(pending);
        pending = Buffer.from(parsed.rest);

        for (const message of parsed.messages) {
            const response = await fetchImpl(opts.url, {
                method: "POST",
                headers: {
                    Accept: "application/json, text/event-stream",
                    "Content-Type": "application/json",
                    [GATEWAY_HEADER]: opts.headers[GATEWAY_HEADER] ?? "",
                    ...opts.headers,
                },
                body: message,
            });
            const bodies = await jsonRpcBodiesFromHttp(response);

            for (const body of bodies) {
                opts.stdout.write(encodeStdioMessage(body));
            }
        }
    }
}
