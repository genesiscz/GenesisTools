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

        const values = preset?.clientNames.map((c) => c.value) ?? [];

        expect(values).toContain("Claude Code (genesis-tools)");
        // The guard for Martin's 2026-09-14 decision (handoff h_l6hx0tn2 t10): the bare
        // name must never come back. `toContain` on an ARRAY compares elements exactly,
        // so the suffixed form does not satisfy this the way a substring check would.
        expect(values).not.toContain("Claude Code");
        expect(values.every((value) => value !== "Claude Code")).toBe(true);
    });

    test("does not match Rohlik", () => {
        expect(oauthClientPresetFor("https://mcp.rohlik.cz/mcp")).toBeUndefined();
    });
});

describe("suggestedLoginCommand", () => {
    test("quotes a client name with spaces", () => {
        expect(suggestedLoginCommand("figma", "Claude Code (genesis-tools)")).toContain(
            '--client-name "Claude Code (genesis-tools)"'
        );
    });
});

describe("clientNameSelectOptions", () => {
    test("Figma prompt lists only whitelist names", () => {
        const preset = oauthClientPresetFor("https://mcp.figma.com/mcp");

        expect(preset).toBeDefined();

        const values = clientNameSelectOptions(preset!).map((row) => row.value);

        expect(values).toEqual(["Claude Code (genesis-tools)", CLIENT_NAME_ABORT]);
        expect(values).not.toContain("Claude Code");
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
        expect(view.retry).toHaveLength(1);
        expect(view.retry[0]).toContain('--client-name "Claude Code (genesis-tools)"');
        expect(view.retry.join("\n")).not.toContain(CLIENT_NAME_DEFAULT);
        // A retry line offering the bare name would end with the closing quote right
        // after it, which is the shape the suffixed form cannot produce.
        expect(view.retry.join("\n")).not.toContain('--client-name "Claude Code"');
    });

    test("an unknown server's retry names NO vendor at all", () => {
        const view = describeDcrFailure({
            server: "somewhere",
            mcpUrl: "https://mcp.example.com/mcp",
            status: 403,
            body: "Forbidden",
            clientName: CLIENT_NAME_DEFAULT,
        });

        expect(view.retry).toHaveLength(1);
        expect(view.retry[0]).toContain("--client-name");
        expect(view.retry[0]).toContain("<name>");
        // The Figma prefix gate is one vendor's measured quirk. This branch runs for a
        // server nobody has measured, so suggesting any vendor's name here would be a
        // guess dressed as advice. Substring checks are right for this one: the goal is
        // ZERO occurrences anywhere in the suggestion, not the absence of one value.
        for (const vendor of ["Claude Code", "Claude", "Cursor", "VS Code", "Windsurf", "Zed", "Codex"]) {
            expect(view.retry.join("\n")).not.toContain(vendor);
        }

        expect(view.issue).toContain("client_name");
        expect(view.issue).not.toContain("Claude");
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
