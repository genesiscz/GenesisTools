import { describe, expect, it } from "bun:test";
import { Router } from "@app/dev-dashboard/server/router";
import type { RouteResult } from "@app/dev-dashboard/server/types";

const ok = (): RouteResult => ({ kind: "json", status: 200, body: {} });

describe("Router", () => {
    it("matches an exact static route by method + path", () => {
        const r = new Router();
        r.add({ method: "GET", pattern: "/api/system/pulse", handler: ok });
        const m = r.match("GET", "/api/system/pulse");
        expect(m).not.toBeNull();
        expect(m?.params).toEqual({});
    });

    it("captures a :param segment", () => {
        const r = new Router();
        r.add({ method: "GET", pattern: "/share/:slug", handler: ok });
        const m = r.match("GET", "/share/abc123");
        expect(m?.params).toEqual({ slug: "abc123" });
    });

    it("does not match a :param across a slash", () => {
        const r = new Router();
        r.add({ method: "GET", pattern: "/share/:slug", handler: ok });
        expect(r.match("GET", "/share/abc/def")).toBeNull();
    });

    it("distinguishes methods on the same path", () => {
        const r = new Router();
        r.add({ method: "GET", pattern: "/api/todos", handler: ok });
        r.add({ method: "POST", pattern: "/api/todos", handler: ok });
        expect(r.match("DELETE", "/api/todos")).toBeNull();
        expect(r.match("POST", "/api/todos")).not.toBeNull();
    });
});
