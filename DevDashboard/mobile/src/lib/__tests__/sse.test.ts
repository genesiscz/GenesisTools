import { parseSseFrame } from "@/lib/sse-frame";
import { describe, expect, it } from "bun:test";

describe("parseSseFrame", () => {
    it("extracts the JSON payload from a data frame", () => {
        expect(parseSseFrame('data: {"id":"1"}')).toBe('{"id":"1"}');
    });

    it("strips exactly one leading space after the colon", () => {
        expect(parseSseFrame("data:no-space")).toBe("no-space");
        expect(parseSseFrame("data:  two-spaces")).toBe(" two-spaces");
    });

    it("returns null for a keep-alive comment frame", () => {
        expect(parseSseFrame(":ping")).toBeNull();
    });

    it("returns null for an event/id-only frame (no data line)", () => {
        expect(parseSseFrame("event: ready\nid: 7")).toBeNull();
    });

    it("concatenates multiple data lines with a newline (SSE multiline)", () => {
        expect(parseSseFrame("data: line1\ndata: line2")).toBe("line1\nline2");
    });
});
