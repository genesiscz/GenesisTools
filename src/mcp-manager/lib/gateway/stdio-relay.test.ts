import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "../auth/constants.ts";
import { encodeStdioFrame, jsonRpcBodyFromHttp, parseStdioFrames, runStdioHttpRelay } from "./stdio-relay.ts";

describe("stdio frames", () => {
    test("round-trips a JSON-RPC initialize", () => {
        const json = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
        const framed = encodeStdioFrame(json);
        const parsed = parseStdioFrames(framed);

        expect(parsed.messages).toEqual([json]);
        expect(parsed.rest.length).toBe(0);
    });
});

describe("jsonRpcBodyFromHttp", () => {
    test("unwraps the last SSE data line", async () => {
        const response = new Response('event: message\ndata: {"id":1,"result":{"ok":true}}\n\n', {
            headers: { "Content-Type": "text/event-stream" },
        });

        expect(await jsonRpcBodyFromHttp(response)).toBe('{"id":1,"result":{"ok":true}}');
    });
});

describe("runStdioHttpRelay", () => {
    test("completes initialize over stdin/stdout against an HTTP MCP", async () => {
        const init =
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}';
        const reply =
            '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"upstream","version":"0"}}}';
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                expect(request.headers.get(GATEWAY_HEADER)).toBe("local");
                expect(await request.text()).toBe(init);

                return new Response(reply, { headers: { "Content-Type": "application/json" } });
            },
        });
        const chunks: Buffer[] = [];
        const stdin = (async function* () {
            yield encodeStdioFrame(init);
        })();

        await runStdioHttpRelay({
            url: `http://127.0.0.1:${http.port}/mcp/rohlik`,
            headers: { [GATEWAY_HEADER]: "local" },
            stdin,
            stdout: {
                write(chunk) {
                    chunks.push(Buffer.from(chunk));
                },
            },
        });
        http.stop(true);

        const out = parseStdioFrames(Buffer.concat(chunks));
        expect(out.messages).toEqual([reply]);
    });
});
