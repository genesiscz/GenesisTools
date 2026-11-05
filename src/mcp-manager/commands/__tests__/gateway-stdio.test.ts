import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as configUtils from "@app/mcp-manager/utils/config.utils.js";
import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { GATEWAY_HEADER } from "../../lib/auth/constants.ts";
import * as secrets from "../../lib/auth/secrets.ts";
import * as ensure from "../../lib/gateway/ensure.ts";
import { parseStdioMessages } from "../../lib/gateway/stdio-relay.ts";
import { stdioRelayRoute } from "../../lib/gateway/stdio-route.ts";
import { gatewayStdio } from "../gateway.ts";

setupStorageSandbox();

const INIT =
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}';
const REPLY =
    '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2026-07-28","capabilities":{},"serverInfo":{"name":"upstream","version":"0"}}}';

function stdioPair(lines: string[]): {
    stdin: AsyncIterable<Uint8Array>;
    stdout: { write(chunk: Uint8Array): unknown };
    replies: () => string[];
} {
    const chunks: Buffer[] = [];
    const stdin = (async function* () {
        yield Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8");
    })();

    return {
        stdin,
        stdout: {
            write(chunk: Uint8Array) {
                chunks.push(Buffer.from(chunk));
            },
        },
        replies: () => parseStdioMessages(Buffer.concat(chunks)).messages,
    };
}

function gatewayMustNotRun(): void {
    spyOn(ensure, "ensureGatewayUp").mockImplementation(() => {
        throw new Error("a direct server must not start the gateway");
    });
    spyOn(secrets, "ensureGatewayClientToken").mockImplementation(() => {
        throw new Error("a direct server must not read the gateway token");
    });
}

afterEach(() => {
    mock.restore();
    process.exitCode = 0;
});

describe("stdioRelayRoute", () => {
    it("relays a plain http server straight to its url with its stored headers", () => {
        const route = stdioRelayRoute("vault", {
            type: "http",
            url: "http://127.0.0.1:1/mcp",
            headers: { Authorization: "Bearer fixture" },
        });

        expect(route).toEqual({
            kind: "direct",
            url: "http://127.0.0.1:1/mcp",
            headers: { Authorization: "Bearer fixture" },
        });
    });

    it("keeps an oauth gateway server on the gateway", () => {
        const route = stdioRelayRoute("docs", {
            type: "http",
            url: "https://docs.example.com/mcp",
            auth: { kind: "oauth", gateway: true },
        });

        expect(route).toEqual({ kind: "gateway" });
    });

    it("refuses a stdio server, an sse server and a missing one", () => {
        expect(stdioRelayRoute("local", { type: "stdio", command: "x" }).kind).toBe("refused");
        expect(stdioRelayRoute("old", { type: "sse", url: "http://127.0.0.1:1/sse" }).kind).toBe("refused");
        expect(stdioRelayRoute("ghost", undefined).kind).toBe("refused");
    });
});

describe("gatewayStdio", () => {
    it("sends the stored header to a plain http server and round-trips the stdio bytes", async () => {
        const seen: { auth: string | null; gateway: string | null; body: string }[] = [];
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
                seen.push({
                    auth: request.headers.get("authorization"),
                    gateway: request.headers.get(GATEWAY_HEADER),
                    body: await request.text(),
                });

                return new Response(REPLY, { headers: { "Content-Type": "application/json" } });
            },
        });
        const config: UnifiedMCPConfig = {
            mcpServers: {
                vault: {
                    type: "http",
                    url: `http://127.0.0.1:${http.port}/mcp`,
                    headers: { Authorization: "Bearer fixture-token" },
                },
            },
        };
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(config);
        gatewayMustNotRun();
        const io = stdioPair([INIT]);

        try {
            await gatewayStdio("vault", io);
        } finally {
            http.stop(true);
        }

        expect(process.exitCode ?? 0).toBe(0);
        expect(seen).toEqual([{ auth: "Bearer fixture-token", gateway: null, body: INIT }]);
        expect(io.replies()).toEqual([REPLY]);
    });

    it("still relays an oauth gateway server through the local gateway with the gateway header", async () => {
        const seen: { path: string; gateway: string | null }[] = [];
        const http = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
                seen.push({ path: new URL(request.url).pathname, gateway: request.headers.get(GATEWAY_HEADER) });

                return new Response(REPLY, { headers: { "Content-Type": "application/json" } });
            },
        });
        const config: UnifiedMCPConfig = {
            gateway: { listen: { host: "127.0.0.1", port: http.port } },
            mcpServers: {
                docs: { type: "http", url: "https://docs.example.com/mcp", auth: { kind: "oauth", gateway: true } },
            },
        };
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(config);
        const up = spyOn(ensure, "ensureGatewayUp").mockResolvedValue(undefined);
        spyOn(secrets, "ensureGatewayClientToken").mockResolvedValue("local-token");
        const io = stdioPair([INIT]);

        try {
            await gatewayStdio("docs", io);
        } finally {
            http.stop(true);
        }

        expect(up).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([{ path: "/mcp/docs", gateway: "local-token" }]);
        expect(io.replies()).toEqual([REPLY]);
    });

    it("refuses a stdio server without starting the gateway", async () => {
        const config: UnifiedMCPConfig = { mcpServers: { local: { type: "stdio", command: "x" } } };
        spyOn(configUtils, "readUnifiedConfig").mockResolvedValue(config);
        gatewayMustNotRun();
        const io = stdioPair([INIT]);

        await gatewayStdio("local", io);

        expect(process.exitCode).toBe(1);
        expect(io.replies()).toEqual([]);
    });
});
