import { Buffer } from "node:buffer";
import { GATEWAY_HEADER } from "../auth/constants.ts";

export function encodeStdioFrame(json: string): Buffer {
    const length = Buffer.byteLength(json, "utf8");

    return Buffer.from(`Content-Length: ${length}\r\n\r\n${json}`, "utf8");
}

export function parseStdioFrames(buffer: Buffer): { messages: string[]; rest: Buffer } {
    const messages: string[] = [];
    let rest = buffer;

    while (true) {
        const headerEnd = rest.indexOf("\r\n\r\n");

        if (headerEnd < 0) {
            break;
        }

        const header = rest.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);

        if (!match) {
            break;
        }

        const length = Number(match[1]);
        const start = headerEnd + 4;

        if (rest.length < start + length) {
            break;
        }

        messages.push(rest.subarray(start, start + length).toString("utf8"));
        rest = rest.subarray(start + length);
    }

    return { messages, rest };
}

export async function jsonRpcBodyFromHttp(response: Response): Promise<string> {
    const type = response.headers.get("content-type") ?? "";
    const text = await response.text();

    if (!type.includes("text/event-stream")) {
        return text;
    }

    const data = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0);

    return data.at(-1) ?? text;
}

export async function runStdioHttpRelay(opts: {
    url: string;
    headers: Record<string, string>;
    stdin: AsyncIterable<Uint8Array>;
    stdout: { write(chunk: Uint8Array): unknown };
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    let pending = Buffer.alloc(0);

    for await (const chunk of opts.stdin) {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        const parsed = parseStdioFrames(pending);
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
            const body = await jsonRpcBodyFromHttp(response);
            opts.stdout.write(encodeStdioFrame(body));
        }
    }
}
