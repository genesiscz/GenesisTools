import { describe, expect, test } from "bun:test";
import { CLIENT_NAME_DEFAULT } from "./constants.ts";
import {
    CLIENT_NAME_ABORT,
    clientNameSelectOptions,
    describeDcrFailure,
    oauthClientPresetFor,
    suggestedLoginCommand,
} from "./presets.ts";

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

describe("clientNameSelectOptions", () => {
    test("Figma prompt lists only whitelist names", () => {
        const preset = oauthClientPresetFor("https://mcp.figma.com/mcp");

        expect(preset).toBeDefined();

        const values = clientNameSelectOptions(preset!).map((row) => row.value);

        expect(values).toEqual(["Claude Code", "Claude Code (genesis-tools)", CLIENT_NAME_ABORT]);
        expect(values).not.toContain(CLIENT_NAME_DEFAULT);
        expect(clientNameSelectOptions(preset!).some((row) => row.hint === "likely refused")).toBe(false);
    });
});

describe("describeDcrFailure", () => {
    test("Figma 403 keeps the HTTP body and the hint on separate fields", () => {
        const view = describeDcrFailure({
            server: "figma",
            mcpUrl: "https://mcp.figma.com/mcp",
            status: 403,
            body: "Forbidden",
            clientName: CLIENT_NAME_DEFAULT,
        });

        expect(view.title).toBe("Dynamic client registration failed (HTTP 403).");
        expect(view.title).not.toContain("Forbidden");
        expect(view.title).not.toContain("Figma");
        expect(view.detail).toEqual([`client_name: ${CLIENT_NAME_DEFAULT}`, "Server said: Forbidden"]);
        expect(view.issue).toContain("Claude Code");
        expect(view.issue?.startsWith("Figma")).toBe(true);
        expect(view.retry).toHaveLength(2);
        expect(view.retry[0]).toContain('--client-name "Claude Code"');
        expect(view.retry[1]).toContain('--client-name "Claude Code (genesis-tools)"');
        expect(view.retry.join("\n")).not.toContain(CLIENT_NAME_DEFAULT);
    });

    test("non-403 has no retry list", () => {
        const view = describeDcrFailure({
            server: "figma",
            mcpUrl: "https://mcp.figma.com/mcp",
            status: 500,
            body: "nope",
            clientName: "Claude Code",
        });

        expect(view.issue).toBeUndefined();
        expect(view.retry).toEqual([]);
    });
});
