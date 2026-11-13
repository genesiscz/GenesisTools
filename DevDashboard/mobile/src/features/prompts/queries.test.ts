import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createFixtureClient } from "@/api/fixture-wire";
import { prepareQuery } from "@/features/prompts/queries";

const client = createFixtureClient();

function prepare(vars: Record<string, string>) {
    return new QueryClient().fetchQuery(prepareQuery(client, { name: "fix-review", session: "s-1", vars }));
}

describe("prepared prompts over the fixture wire", () => {
    it("fills a supplied value and the session's branch, and is ready", async () => {
        const prepared = await prepare({ pr: "12" });
        expect(prepared.missing).toEqual([]);
        expect(prepared.text).toContain("PR 12 (feat/cart)");
        expect(prepared.variables).toEqual([
            { name: "pr", value: "12", source: "given" },
            { name: "branch", value: "feat/cart", source: "session" },
        ]);
    });

    it("keeps an empty value missing, as the Mac does, so the prompt is not ready", async () => {
        const prepared = await prepare({ pr: "" });
        expect(prepared.missing).toEqual(["pr"]);
        expect(prepared.text).toContain("{{pr}}");
        expect(prepared.variables[0]).toEqual({ name: "pr", value: null, source: "missing" });
    });

    it("inserts a value literally, replacement tokens included", async () => {
        const prepared = await prepare({ pr: "$& and $1" });
        expect(prepared.text).toContain("PR $& and $1 (feat/cart)");
    });
});
