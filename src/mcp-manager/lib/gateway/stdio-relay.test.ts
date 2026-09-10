import { describe, expect, test } from "bun:test";
import { GATEWAY_HEADER } from "../auth/constants.ts";
import { encodeStdioMessage, jsonRpcBodiesFromHttp, parseStdioMessages, runStdioHttpRelay } from "./stdio-relay.ts";

describe("stdio newline JSON-RPC", () => {
    test("round-trips a JSON-RPC initialize", () => {
        const json = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
        const framed = encodeStdioMessage(json);
        const parsed = parseStdioMessages(framed);

        expect(framed.toString("utf8")).toBe(`${json}\n`);
        expect(parsed.messages).toEqual([json]);
        expect(parsed.rest.length).toBe(0);
    });

    test("keeps a partial line in rest until newline", () => {
        const parsed = parseStdioMessages(Buffer.from('{"jsonrpc":"2.0","id":1', "utf8"));

        expect(parsed.messages).toEqual([]);
        expect(parsed.rest.toString("utf8")).toBe('{"jsonrpc":"2.0","id":1');
    });

    test("does not corrupt a multi-byte UTF-8 character split across the buffer", () => {
        const json = '{"jsonrpc":"2.0","id":1,"params":{"q":"café"}}';
        const full = Buffer.from(`${json}\n`, "utf8");
        const splitAt = full.indexOf(0xc3);

        expect(splitAt).toBeGreaterThan(0);

        const first = parseStdioMessages(full.subarray(0, splitAt + 1));
        expect(first.messages).toEqual([]);
        expect(first.rest.equals(full.subarray(0, splitAt + 1))).toBe(true);

        const second = parseStdioMessages(Buffer.concat([first.rest, full.subarray(splitAt + 1)]));
        expect(second.messages).toEqual([json]);
        expect(second.rest.length).toBe(0);
    });
});

describe("jsonRpcBodiesFromHttp", () => {
    test("unwraps every SSE data line", async () => {
        const response = new Response(
            'event: message\ndata: {"id":1,"result":{"ok":true}}\n\nevent: message\ndata: {"method":"notifications/progress"}\n\n',
            {
                headers: { "Content-Type": "text/event-stream" },
            }
        );

        expect(await jsonRpcBodiesFromHttp(response)).toEqual([
            '{"id":1,"result":{"ok":true}}',
            '{"method":"notifications/progress"}',
        ]);
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
            yield Buffer.from(`${init}\n`, "utf8");
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

        const out = parseStdioMessages(Buffer.concat(chunks));
        expect(out.messages).toEqual([reply]);
    });

    test("relays two newline messages from one chunk", async () => {
        const seen: string[] = [];
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                seen.push(await request.text());

                return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
        const a = '{"jsonrpc":"2.0","id":1,"method":"a"}';
        const b = '{"jsonrpc":"2.0","id":2,"method":"b"}';
        const stdin = (async function* () {
            yield Buffer.from(`${a}\n${b}\n`, "utf8");
        })();

        await runStdioHttpRelay({
            url: `http://127.0.0.1:${http.port}/mcp/rohlik`,
            headers: { [GATEWAY_HEADER]: "local" },
            stdin,
            stdout: { write() {} },
        });
        http.stop(true);

        expect(seen).toEqual([a, b]);
    });

    test("relays a message whose UTF-8 bytes split across two stdin chunks", async () => {
        const json = '{"jsonrpc":"2.0","id":1,"params":{"q":"café"}}';
        const full = Buffer.from(`${json}\n`, "utf8");
        const splitAt = full.indexOf(0xc3);
        const seen: string[] = [];
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                seen.push(await request.text());

                return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
        const stdin = (async function* () {
            yield full.subarray(0, splitAt + 1);
            yield full.subarray(splitAt + 1);
        })();

        await runStdioHttpRelay({
            url: `http://127.0.0.1:${http.port}/mcp/rohlik`,
            headers: { [GATEWAY_HEADER]: "local" },
            stdin,
            stdout: { write() {} },
        });
        http.stop(true);

        expect(seen).toEqual([json]);
    });

    test("turns a non-JSON HTTP 500 into a JSON-RPC error line", async () => {
        const init = '{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}';
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return new Response("<html>nope</html>", { status: 500 });
            },
        });
        const chunks: Buffer[] = [];
        const stdin = (async function* () {
            yield Buffer.from(`${init}\n`, "utf8");
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

        const out = parseStdioMessages(Buffer.concat(chunks));
        expect(out.messages).toHaveLength(1);
        expect(out.messages[0]).toContain('"id":7');
        expect(out.messages[0]).toContain("gateway HTTP 500");
        expect(out.messages[0]).not.toContain("<html>");
    });

    test("writes nothing when the upstream returns 202", async () => {
        const note = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return new Response(null, { status: 202 });
            },
        });
        const chunks: Buffer[] = [];
        const stdin = (async function* () {
            yield Buffer.from(`${note}\n`, "utf8");
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

        expect(Buffer.concat(chunks).length).toBe(0);
    });

    test("stores mcp-session-id from initialize and sends it on the next request", async () => {
        const seen: Array<string | null> = [];
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                seen.push(request.headers.get("mcp-session-id"));
                await request.text();

                if (seen.length === 1) {
                    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
                        headers: {
                            "Content-Type": "application/json",
                            "mcp-session-id": "sess-1",
                        },
                    });
                }

                return new Response('{"jsonrpc":"2.0","id":2,"result":{}}', {
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
        const stdin = (async function* () {
            yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', "utf8");
            yield Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n', "utf8");
        })();

        await runStdioHttpRelay({
            url: `http://127.0.0.1:${http.port}/mcp/rohlik`,
            headers: { [GATEWAY_HEADER]: "local" },
            stdin,
            stdout: { write() {} },
        });
        http.stop(true);

        expect(seen).toEqual([null, "sess-1"]);
    });
});
