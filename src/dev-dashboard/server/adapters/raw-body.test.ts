import { describe, expect, it } from "bun:test";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import { Router } from "@app/dev-dashboard/server/router";
import type { RouteDef, RouteServices } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";

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
});
