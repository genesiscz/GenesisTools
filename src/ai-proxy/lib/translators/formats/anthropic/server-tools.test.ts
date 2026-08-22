import { describe, expect, it } from "bun:test";
import { findServerTool } from "./server-tools";

describe("findServerTool", () => {
    it("finds an Anthropic server tool by its versioned type", () => {
        const body = {
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        };

        expect(findServerTool(body)).toBe("web_search_20250305");
    });

    it("ignores custom tools, with and without an explicit type", () => {
        const body = {
            tools: [
                { name: "Read", description: "Reads a file", input_schema: { type: "object" } },
                { type: "custom", name: "Bash", description: "Runs a command", input_schema: { type: "object" } },
            ],
        };

        expect(findServerTool(body)).toBeUndefined();
    });

    it("handles missing or malformed tools arrays", () => {
        expect(findServerTool({})).toBeUndefined();
        expect(findServerTool({ tools: "nope" })).toBeUndefined();
        expect(findServerTool({ tools: [null, 42, "x"] })).toBeUndefined();
    });
});
