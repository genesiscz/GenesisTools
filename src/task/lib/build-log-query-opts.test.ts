import { describe, expect, it } from "bun:test";
import { buildLogQueryOpts } from "@app/task/lib/build-log-query-opts";

describe("buildLogQueryOpts", () => {
    it("defaults head/tail unset when --all is not set", () => {
        const opts = buildLogQueryOpts("metro", {});

        expect(opts.head).toBeUndefined();
        expect(opts.tail).toBeUndefined();
        expect(opts.all).toBe(false);
    });

    it("passes all true when --all is set", () => {
        const opts = buildLogQueryOpts("metro", { all: true });

        expect(opts.all).toBe(true);
        expect(opts.head).toBeUndefined();
        expect(opts.tail).toBeUndefined();
    });

    it("parses --head and --tail", () => {
        const opts = buildLogQueryOpts("metro", { head: "5", tail: "10" });

        expect(opts.head).toBe(5);
        expect(opts.tail).toBe(10);
    });

    it("prefers --all over explicit --head/--tail", () => {
        const opts = buildLogQueryOpts("metro", { all: true, head: "5", tail: "10" });

        expect(opts.all).toBe(true);
    });
});
