import { describe, expect, it } from "bun:test";
import { buildLogQueryOpts } from "@app/task/lib/build-log-query-opts";

describe("buildLogQueryOpts", () => {
    it("defaults to 50 lines when --all is not set (eval2 bug #7 baseline)", () => {
        const opts = buildLogQueryOpts("metro", {});

        expect(opts.lines).toBe(50);
    });

    it("passes lines undefined when --all is set (eval2 bug #7)", () => {
        const opts = buildLogQueryOpts("metro", { all: true });

        expect(opts.lines).toBeUndefined();
    });

    it("respects explicit --lines over default", () => {
        const opts = buildLogQueryOpts("metro", { lines: "200" });

        expect(opts.lines).toBe(200);
    });

    it("prefers --all over explicit --lines", () => {
        const opts = buildLogQueryOpts("metro", { all: true, lines: "200" });

        expect(opts.lines).toBeUndefined();
    });
});
