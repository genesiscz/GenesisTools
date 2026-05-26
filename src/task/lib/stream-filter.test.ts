import { describe, expect, it } from "bun:test";
import { resolveStreamFilter } from "@app/task/lib/stream-filter";

describe("resolveStreamFilter", () => {
    it("defaults to both streams", () => {
        const streams = resolveStreamFilter({});
        expect(streams.has("stdout")).toBe(true);
        expect(streams.has("stderr")).toBe(true);
    });

    it("filters stdout only", () => {
        const streams = resolveStreamFilter({ stdout: true });
        expect([...streams]).toEqual(["stdout"]);
    });

    it("filters stderr only", () => {
        const streams = resolveStreamFilter({ stderr: true });
        expect([...streams]).toEqual(["stderr"]);
    });
});
