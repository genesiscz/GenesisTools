import { describe, expect, test } from "bun:test";
import { oauthClientPresetFor, suggestedLoginCommand } from "./presets.ts";

describe("oauthClientPresetFor", () => {
    test("matches Figma MCP hosts", () => {
        const preset = oauthClientPresetFor("https://mcp.figma.com/mcp");

        expect(preset?.id).toBe("figma");
        expect(preset?.clientNames.map((c) => c.value)).toContain("Claude Code");
    });

    test("does not match Rohlik", () => {
        expect(oauthClientPresetFor("https://mcp.rohlik.cz/mcp")).toBeUndefined();
    });
});

describe("suggestedLoginCommand", () => {
    test("quotes a client name with spaces", () => {
        expect(suggestedLoginCommand("figma", "Claude Code")).toContain('--client-name "Claude Code"');
    });
});
