import { describe, expect, it } from "bun:test";
import { fullDiffEnabled, sectionsOf, sectionsOfCalls } from "./sections";

const NOTE = [
    "# Diff of toolu_x",
    "",
    "```sh",
    "sed -i s/a/b/ src/a.ts src/b.ts",
    "```",
    "",
    "## /repo/src/a.ts (+1 -1)",
    "",
    "```diff",
    "diff --git a/a.ts b/a.ts",
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-a",
    "+b",
    " same",
    "```",
    "",
    "## /repo/src/b.ts (+0 -1)",
    "",
    "```diff",
    "@@ -1,1 +0,0 @@",
    "-gone",
    "```",
    "",
    "## Changed, past the file cap",
    "- /repo/src/c.ts",
].join("\n");

describe("the full-diff mod's note reader", () => {
    it("reads each file of a note from its first hunk, and nothing else", () => {
        const sections = sectionsOf(NOTE);

        expect(sections.map((section) => section.path)).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
        expect(sections[0]?.patch).toBe("@@ -1,2 +1,2 @@\n-a\n+b\n same");
        expect(sections[1]?.patch).toBe("@@ -1,1 +0,0 @@\n-gone");
        expect(sectionsOf("# Diff of toolu_y\n\n```sh\nls\n```\n")).toEqual([]);
    });

    it("reads a group's notes in call order, skips a call with no note, and stops at the budget", async () => {
        const notes: Record<string, string> = { first: NOTE, third: NOTE };
        const read = async (id: string) => {
            const note = notes[id];

            if (note === undefined) {
                throw new Error(`no note for ${id}`);
            }

            return note;
        };

        const all = await sectionsOfCalls({ ids: ["first", "second", "third"], read, maxChars: 1_000 });

        expect(all.map((section) => `${section.call} ${section.path}`)).toEqual([
            "first /repo/src/a.ts",
            "first /repo/src/b.ts",
            "third /repo/src/a.ts",
            "third /repo/src/b.ts",
        ]);

        const cut = await sectionsOfCalls({ ids: ["first", "third"], read, maxChars: 40 });

        expect(cut.map((section) => section.path)).toEqual(["/repo/src/a.ts"]);
    });

    it("is on unless the hooks file sets mods.fullDiff to false", () => {
        expect(fullDiffEnabled(undefined)).toBe(true);
        expect(fullDiffEnabled("not json")).toBe(true);
        expect(fullDiffEnabled('{"mods":{"fullDiff":"no"}}')).toBe(true);
        expect(fullDiffEnabled('{"mods":{"fullDiff":false}}')).toBe(false);
        expect(fullDiffEnabled('{"diff":{}}')).toBe(true);
    });
});
