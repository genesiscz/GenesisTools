import { describe, expect, it } from "bun:test";
import type { PulseSnapshot } from "@app/dev-dashboard/lib/system/types";
import { routerToResponse, toResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import type { SseEmitter } from "@app/dev-dashboard/server/types";
import type { SystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { Router } from "@app/dev-dashboard/server/router";

const fakeCollector: SystemCollector = {
    platform: "macos",
    collect: () => Promise.resolve({ capturedAt: null } as unknown as PulseSnapshot),
};
const services = { collector: fakeCollector };

describe("routerToResponse (bun.serve)", () => {
    it("returns a JSON Response for a matched route", async () => {
        const router = new Router().add({
            method: "GET",
            pattern: "/x",
            handler: () => ({ kind: "json", status: 200, body: { ok: true } }),
        });
        const res = await routerToResponse(router, new Request("http://h/x"), { services });

        expect(res?.status).toBe(200);
        expect(await res?.json()).toEqual({ ok: true });
    });

    it("returns null for an unmatched route", async () => {
        const res = await routerToResponse(new Router(), new Request("http://h/none"), { services });

        expect(res).toBeNull();
    });

    it("calling emit.comment/emit.data after the stream is canceled does not throw", async () => {
        let emitRef: SseEmitter | null = null;
        const response = toResponse({
            kind: "sse",
            start: (emit) => {
                emitRef = emit;
                return { close: () => {} };
            },
        });

        await response.body?.cancel();

        expect(() => emitRef?.comment(" ping")).not.toThrow();
        expect(() => emitRef?.data("test")).not.toThrow();
    });

    it("streams an SSE body with the right content-type", async () => {
        const router = new Router().add({
            method: "GET",
            pattern: "/s",
            longLived: true,
            handler: () => ({
                kind: "sse",
                start: (emit) => {
                    emit.data("hi");
                    return { close: () => {} };
                },
            }),
        });
        const res = await routerToResponse(router, new Request("http://h/s"), { services });

        expect(res?.headers.get("content-type")).toContain("text/event-stream");
    });
});
