import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { jevToolEntries } from "./genesis-tools";

describe("jevToolEntries", () => {
    test("exposes every Jev MCP tool under the jev_ prefix with a JSON schema", () => {
        const entries = jevToolEntries();
        expect(Object.keys(entries).sort()).toEqual(["jev_compact", "jev_route", "jev_verify", "jev_verify_templates"]);
        for (const [name, entry] of Object.entries(entries)) {
            expect(name.startsWith("jev_")).toBe(true);
            expect(entry.description.length).toBeGreaterThan(0);
            expect(entry.inputSchema.type).toBe("object");
        }
    });

    test("the handler returns JSON text the host can parse back", async () => {
        const entries = jevToolEntries();
        const text = await entries.jev_verify_templates.handler({}, { signal: new AbortController().signal });
        const parsed: { templates?: unknown[] } = SafeJSON.parse(text);
        expect(Array.isArray(parsed.templates)).toBe(true);
    });
});
