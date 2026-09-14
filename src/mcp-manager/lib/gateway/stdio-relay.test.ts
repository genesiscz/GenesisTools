import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
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

    test("a 404 clears the session id, so the next request opens a new session", async () => {
        const seen: Array<string | null> = [];
        let sawReset: (() => void) | undefined;
        const reset = new Promise<void>((resolve) => {
            sawReset = resolve;
        });
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                seen.push(request.headers.get("mcp-session-id"));
                await request.text();

                if (seen.length === 1) {
                    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
                        headers: { "Content-Type": "application/json", "mcp-session-id": "sess-1" },
                    });
                }

                // The upstream forgot the session — the MCP transport's signal to
                // re-initialize. A relay that kept sending sess-1 would 404 forever.
                if (seen.length === 2) {
                    return new Response('{"jsonrpc":"2.0","id":2,"error":{"code":-32001}}', {
                        status: 404,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                return new Response('{"jsonrpc":"2.0","id":3,"result":{}}', {
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
        // The third message is only fed once the relay has HANDLED the 404, not merely
        // once the server has answered it. Dispatch is concurrent after the handshake,
        // so a message already in flight when the 404 lands legitimately still carries
        // the dead id; the guarantee is about the next message the relay STARTS.
        //
        // Latched on the stdout write, not on a sleep. `dispatch` clears sessionId
        // BEFORE it writes the 404 body, so the second write is ordered strictly after
        // the reset — which a `Bun.sleep(10)` only guessed at, and a loaded CI host
        // would have turned into a flake with an assertion failure that reads like a
        // real bug.
        let writes = 0;
        const stdin = (async function* () {
            yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', "utf8");
            yield Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n', "utf8");
            await reset;
            yield Buffer.from('{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}\n', "utf8");
        })();

        await runStdioHttpRelay({
            url: `http://127.0.0.1:${http.port}/mcp/rohlik`,
            headers: { [GATEWAY_HEADER]: "local" },
            stdin,
            stdout: {
                write() {
                    writes += 1;

                    if (writes === 2) {
                        sawReset?.();
                    }
                },
            },
        });
        http.stop(true);

        expect(seen).toEqual([null, "sess-1", null]);
    });
});

describe("runStdioHttpRelay concurrency", () => {
    test("a slow call does not hold up the messages queued behind it", async () => {
        const order: string[] = [];
        let releaseSlow: (() => void) | undefined;
        const slow = new Promise<void>((resolve) => {
            releaseSlow = resolve;
        });
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                const body = await request.text();
                const id = SafeJSON.parse(body, { strict: true }) as { id: number };

                if (id.id === 2) {
                    await slow;
                }

                order.push(`served:${id.id}`);

                return new Response(`{"jsonrpc":"2.0","id":${id.id},"result":{}}`, {
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
        const stdin = (async function* () {
            yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n', "utf8");
            yield Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}\n', "utf8");
            yield Buffer.from('{"jsonrpc":"2.0","id":3,"method":"notifications/cancelled","params":{}}\n', "utf8");
        })();

        const relay = runStdioHttpRelay({
            url: `http://127.0.0.1:${http.port}/mcp/rohlik`,
            headers: { [GATEWAY_HEADER]: "local" },
            stdin,
            stdout: { write() {} },
        });

        // id 3 must reach the upstream while id 2 is still parked. Serialized, this
        // never happens and the await below deadlocks against releaseSlow.
        while (!order.includes("served:3")) {
            await Bun.sleep(5);
        }

        releaseSlow?.();
        await relay;
        http.stop(true);

        expect(order).toEqual(["served:1", "served:3", "served:2"]);
    });

    test("the handshake stays serialized so the session id is set before the next send", async () => {
        const seen: Array<string | null> = [];
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                seen.push(request.headers.get("mcp-session-id"));
                await request.text();

                return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
                    headers: {
                        "Content-Type": "application/json",
                        ...(seen.length === 1 ? { "mcp-session-id": "sess-1" } : {}),
                    },
                });
            },
        });
        const stdin = (async function* () {
            yield Buffer.from(
                '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' +
                    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' +
                    '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}\n',
                "utf8"
            );
        })();

        await runStdioHttpRelay({
            url: `http://127.0.0.1:${http.port}/mcp/rohlik`,
            headers: { [GATEWAY_HEADER]: "local" },
            stdin,
            stdout: { write() {} },
        });
        http.stop(true);

        expect(seen[0]).toBeNull();
        expect(seen.slice(1)).toEqual(["sess-1", "sess-1"]);
    });
});
