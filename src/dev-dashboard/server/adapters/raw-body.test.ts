import { describe, expect, it } from "bun:test";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import { Router } from "@app/dev-dashboard/server/router";
import type { RouteDef, RouteServices } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@genesiscz/utils/json";

const services = { collector: { collect: () => Promise.reject(new Error("unused")) } } as unknown as RouteServices;

describe("readRawBody", () => {
    it("delivers the exact request bytes to the handler", async () => {
        const payload = new Uint8Array([0x1f, 0x8b, 0x00, 0xff, 0x42]);
        const defs: RouteDef[] = [
            {
                method: "PUT",
                pattern: "/api/echo-bytes",
                handler: async (ctx) => {
                    const body = await ctx.readRawBody();
                    return { kind: "json", status: 200, body: { len: body.length, first: body[0], last: body[4] } };
                },
            },
        ];
        const router = new Router().addAll(defs);
        const req = new Request("http://x/api/echo-bytes", { method: "PUT", body: payload });
        const res = await routerToResponse(router, req, { services });
        expect(res).not.toBeNull();
        const json = (await res?.json()) as { len: number; first: number; last: number };
        expect(json).toEqual({ len: 5, first: 0x1f, last: 0x42 });
    });

    it("readJson still works after readRawBody exists on the contract", async () => {
        const defs: RouteDef[] = [
            {
                method: "POST",
                pattern: "/api/echo-json",
                handler: async (ctx) => {
                    const body = await ctx.readJson<{ a: number }>();
                    return { kind: "json", status: 200, body };
                },
            },
        ];
        const router = new Router().addAll(defs);
        const req = new Request("http://x/api/echo-json", { method: "POST", body: SafeJSON.stringify({ a: 7 }) });
        const res = await routerToResponse(router, req, { services });
        const json = (await res?.json()) as { a: number };
        expect(json).toEqual({ a: 7 });
    });

    it("returns 413 before an oversized chunked body reaches route work", async () => {
        const chunk = new Uint8Array(1024 * 1024);
        let pulls = 0;
        let afterRead = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(chunk);
                if (pulls === 12) {
                    controller.close();
                }
            },
        });
        const router = new Router().add({
            method: "POST",
            pattern: "/api/echo-json",
            handler: async (ctx) => {
                await ctx.readRawBody();
                afterRead = true;
                return { kind: "json", status: 200, body: { ok: true } };
            },
        });
        const req = new Request("http://x/api/echo-json", {
            method: "POST",
            body,
            // Request streams require this in Bun/Node even though it is not in lib.dom's RequestInit.
            duplex: "half",
        } as RequestInit & { duplex: "half" });
        const res = await routerToResponse(router, req, { services });

        expect(res?.status).toBe(413);
        expect(afterRead).toBe(false);
        expect(pulls).toBeLessThan(12);
    });

    it("keeps a near-limit JSON request working", async () => {
        const payload = SafeJSON.stringify({ value: "x".repeat(64 * 1024) });
        const router = new Router().add({
            method: "POST",
            pattern: "/api/echo-json",
            handler: async (ctx) => ({ kind: "json", status: 200, body: await ctx.readJson() }),
        });
        const res = await routerToResponse(
            router,
            new Request("http://x/api/echo-json", { method: "POST", body: payload }),
            { services }
        );

        expect(res?.status).toBe(200);
        expect((await res?.json()) as { value: string }).toEqual({ value: "x".repeat(64 * 1024) });
    });
});
