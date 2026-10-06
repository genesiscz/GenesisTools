import { describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PulseSnapshot } from "@app/dev-dashboard/lib/system/types";
import { handleWithRouter } from "@app/dev-dashboard/server/adapters/node-connect";
import type { SystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { Router } from "@app/dev-dashboard/server/router";

const fakeCollector: SystemCollector = {
    platform: "macos",
    collect: () => Promise.resolve({ capturedAt: null } as unknown as PulseSnapshot),
};

interface MockResState {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

function mockRes(): { res: ServerResponse; state: MockResState } {
    const state: MockResState = { statusCode: 200, headers: {}, body: "" };
    const res = {
        get statusCode(): number {
            return state.statusCode;
        },
        set statusCode(value: number) {
            state.statusCode = value;
        },
        setHeader(key: string, value: string): void {
            state.headers[key.toLowerCase()] = value;
        },
        write(chunk: string): void {
            state.body += chunk;
        },
        writeHead(code: number, headers?: Record<string, string>): void {
            state.statusCode = code;

            if (headers) {
                Object.assign(state.headers, headers);
            }
        },
        end(chunk?: string | Buffer): void {
            if (chunk) {
                state.body += chunk.toString();
            }
        },
        on(): void {
            // no-op for the json path (no "close" event in tests)
        },
    };

    return { res: res as unknown as ServerResponse, state };
}

function mockReq(method: string, url: string): IncomingMessage {
    return { method, url, headers: { host: "localhost" } } as unknown as IncomingMessage;
}

function bodyReq(chunks: Uint8Array[], contentLength?: number): { req: IncomingMessage; resumed: () => boolean } {
    let didResume = false;
    const req = {
        method: "POST",
        url: "/api/echo-json",
        headers: {
            host: "localhost",
            ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
        },
        resume() {
            didResume = true;
        },
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
                yield chunk;
            }
        },
    } as unknown as IncomingMessage;
    return { req, resumed: () => didResume };
}

describe("handleWithRouter (node/connect)", () => {
    it("serializes a json result with status + content-type", async () => {
        const router = new Router().add({
            method: "GET",
            pattern: "/x",
            handler: () => ({ kind: "json", status: 201, body: { a: 1 } }),
        });
        const { res, state } = mockRes();
        const handled = await handleWithRouter(router, mockReq("GET", "/x"), res, {
            services: { collector: fakeCollector },
        });

        expect(handled).toBe(true);
        expect(state.statusCode).toBe(201);
        expect(state.headers["content-type"]).toContain("application/json");
        expect(state.body).toBe('{"a":1}');
    });

    it("returns false (→ next) for an unmatched route", async () => {
        const router = new Router();
        const { res } = mockRes();
        const handled = await handleWithRouter(router, mockReq("GET", "/nope"), res, {
            services: { collector: fakeCollector },
        });

        expect(handled).toBe(false);
    });

    it("returns 413 from Content-Length before Node retains or parses the body", async () => {
        let routeWork = false;
        const router = new Router().add({
            method: "POST",
            pattern: "/api/echo-json",
            handler: async (ctx) => {
                await ctx.readJson();
                routeWork = true;
                return { kind: "json", status: 200, body: { ok: true } };
            },
        });
        const { req, resumed } = bodyReq([], 8 * 1024 * 1024 + 1);
        const { res, state } = mockRes();

        await handleWithRouter(router, req, res, { services: { collector: fakeCollector } });

        expect(state.statusCode).toBe(413);
        expect(routeWork).toBe(false);
        expect(resumed()).toBe(true);
    });
});
