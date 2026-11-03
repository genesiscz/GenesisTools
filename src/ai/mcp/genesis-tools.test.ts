import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { usageToolEntries } from "./genesis-tools";

/** The test sandbox home has no accounts, no poll file and no history: every answer is empty, never an error. */
describe("usage MCP tools", () => {
    const entries = usageToolEntries();

    test("expose the four read-only tools", () => {
        expect(Object.keys(entries).sort()).toEqual(["usage_advise", "usage_forecast", "usage_limits", "usage_series"]);
    });

    test("usage_limits answers from the snapshots file and says when there is none", async () => {
        const envelope = SafeJSON.parse(await entries.usage_limits.handler({}), { strict: true });

        expect(envelope).toMatchObject({ schema: "usage.limits@1", data: { accounts: [] } });
        expect(envelope.warnings.map((warning: { code: string }) => warning.code)).toEqual(["no-cache"]);
    });

    test("a value the caller can fix comes back as its code, not a thrown error", async () => {
        const refused = SafeJSON.parse(await entries.usage_series.handler({ since: "soon" }), { strict: true });

        expect(refused).toMatchObject({ error: "bad-window" });
    });

    test("an unknown argument is refused by the schema", async () => {
        await expect(entries.usage_advise.handler({ poll: true })).rejects.toThrow();
    });
});
