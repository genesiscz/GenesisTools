import { describe, expect, it } from "bun:test";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { JsonRenderer } from "@app/macos/lib/clones/render/json";
import { TableRenderer } from "@app/macos/lib/clones/render/table";

describe("resolveFormat", () => {
    it("passes through explicit formats", () => {
        expect(resolveFormat("table")).toBe("table");
        expect(resolveFormat("json")).toBe("json");
        expect(resolveFormat("jsonl")).toBe("jsonl");
    });

    it("auto → table or json (never stays 'auto')", () => {
        const r = resolveFormat("auto");
        expect(r === "table" || r === "json").toBe(true);
    });

    it("undefined behaves like auto", () => {
        const r = resolveFormat(undefined);
        expect(r === "table" || r === "json").toBe(true);
    });
});

describe("resolveRenderer", () => {
    it("table → TableRenderer; json/jsonl → JsonRenderer", () => {
        expect(resolveRenderer("table")).toBeInstanceOf(TableRenderer);
        expect(resolveRenderer("json")).toBeInstanceOf(JsonRenderer);
        expect(resolveRenderer("jsonl")).toBeInstanceOf(JsonRenderer);
    });

    it("auto resolves first, never returns a renderer for literal 'auto'", () => {
        const r = resolveRenderer(resolveFormat("auto"));
        expect(r instanceof TableRenderer || r instanceof JsonRenderer).toBe(true);
    });
});
