import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createFixtureClient } from "@/api/fixture-wire";
import { prepareQuery, unappliedVariables } from "@/features/prompts/queries";

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

describe("unapplied prompt values", () => {
    it("holds an edit of a ready prompt back until the Mac has prepared it", async () => {
        const ready = await prepare({ pr: "12" });
        expect(unappliedVariables({}, ready)).toEqual([]);
        // The user edits a value the session or an earlier apply supplied: the text still says 12.
        expect(unappliedVariables({ pr: "13" }, ready)).toEqual(["pr"]);
        expect(unappliedVariables({ branch: "feat/other" }, ready)).toEqual(["branch"]);

        const applied = await prepare({ pr: "13" });
        expect(unappliedVariables({ pr: "13" }, applied)).toEqual([]);
    });

    it("counts an edit back to the prepared value, or an empty one on a missing value, as applied", async () => {
        const missing = await prepare({});
        expect(unappliedVariables({ pr: "" }, missing)).toEqual([]);

        const ready = await prepare({ pr: "12" });
        expect(unappliedVariables({ pr: "12" }, ready)).toEqual([]);
    });
});
