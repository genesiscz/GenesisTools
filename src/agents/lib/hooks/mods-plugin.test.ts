import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    compactionEndsIdleWait,
    IDLE_COMPACT_DEFAULTS,
    IDLE_NOTICE,
    idleCompactSettings,
    idleCompactSkip,
    idleNotice,
} from "../../../../plugins/genesis-tools-mods/hooks/idle";
import {
    fullDiffEnabled,
    isDeletion,
    OPEN_FILE_LINES,
    openByDefault,
    sectionsOf,
    sectionsOfCalls,
} from "../../../../plugins/genesis-tools-mods/hooks/sections";

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
        expect(sections.map((section) => [section.added, section.removed])).toEqual([
            [1, 1],
            [0, 1],
        ]);
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

    it("draws a file the note holds twice once", () => {
        const twice = [NOTE.split("## /repo/src/b.ts")[0], NOTE.split("## /repo/src/b.ts")[0]].join("");

        expect(sectionsOf(twice).map((section) => section.path)).toEqual(["/repo/src/a.ts"]);
    });

    it("folds a whole deletion, a long file and what is past the row's budget by default", () => {
        const file = (path: string, added: number, removed: number, patch = "@@ -1,2 +1,2 @@\n-a\n+b") => ({
            path,
            added,
            removed,
            patch,
        });
        const gone = file("gone.ts", 0, 782, "@@ -1,782 +0,0 @@\n-x");

        expect(isDeletion(gone)).toBe(true);
        expect(isDeletion(file("edit.ts", 0, 1, "@@ -3,2 +3,1 @@\n-x\n y"))).toBe(false);
        expect(
            openByDefault([
                file("small.ts", 1, 1),
                gone,
                file("long.ts", OPEN_FILE_LINES, 1),
                file("mid1.ts", 100, 0),
                file("mid2.ts", 100, 0),
                file("mid3.ts", 100, 0),
            ])
        ).toEqual([true, false, false, true, true, false]);
    });

    it("is on unless the hooks file sets mods.fullDiff to false", () => {
        expect(fullDiffEnabled(undefined)).toBe(true);
        expect(fullDiffEnabled("not json")).toBe(true);
        expect(fullDiffEnabled('{"mods":{"fullDiff":"no"}}')).toBe(true);
        expect(fullDiffEnabled('{"mods":{"fullDiff":false}}')).toBe(false);
        expect(fullDiffEnabled('{"diff":{}}')).toBe(true);
    });
});

describe("idle compaction", () => {
    it("reads its settings from the mods section and keeps the default for a bad value", () => {
        expect(idleCompactSettings(undefined)).toEqual(IDLE_COMPACT_DEFAULTS);
        expect(idleCompactSettings("not json")).toEqual(IDLE_COMPACT_DEFAULTS);
        expect(
            idleCompactSettings(
                SafeJSON.stringify({ mods: { idleCompact: false, idleCompactMinutes: 50, idleCompactMinTokens: 0 } })
            )
        ).toEqual({ enabled: false, minutes: 50, minTokens: 0 });
        // 60 minutes or more would fire after the cache expired.
        expect(
            idleCompactSettings(SafeJSON.stringify({ mods: { idleCompactMinutes: 60, idleCompact: "no" } }))
        ).toEqual(IDLE_COMPACT_DEFAULTS);
    });

    it("compacts only when on, drawn and over the floor", () => {
        const settings = { enabled: true, minutes: 56, minTokens: 200_000 };

        expect(idleCompactSkip({ settings, surfaces: 1, tokens: 300_000 })).toBeUndefined();
        expect(idleCompactSkip({ settings: { ...settings, enabled: false }, surfaces: 1, tokens: 300_000 })).toBe(
            "mods.idleCompact is off"
        );
        expect(idleCompactSkip({ settings, surfaces: 0, tokens: 300_000 })).toContain("no surface");
        expect(idleCompactSkip({ settings, surfaces: 1, tokens: 199_999 })).toContain("under the floor");
        expect(idleCompactSkip({ settings, surfaces: 1, tokens: undefined })).toContain("unknown");
    });

    it("a precompute, a skipped and a subagent compaction leave the armed timer alone", () => {
        expect(compactionEndsIdleWait({ agentId: undefined, trigger: "auto", skipped: false })).toBe(true);
        expect(compactionEndsIdleWait({ agentId: undefined, trigger: "manual", skipped: false })).toBe(true);
        expect(compactionEndsIdleWait({ agentId: undefined, trigger: "precompute", skipped: false })).toBe(false);
        expect(compactionEndsIdleWait({ agentId: undefined, trigger: "auto", skipped: true })).toBe(false);
        expect(compactionEndsIdleWait({ agentId: "a1", trigger: "auto", skipped: false })).toBe(false);
    });

    it("writes a notice that starts with the text the session scan counts", () => {
        const text = idleNotice({ minutes: 56, tokensBefore: 550_000, tokensAfter: 40_000 });

        expect(text.startsWith(IDLE_NOTICE)).toBe(true);
        expect(text).toContain("550,000 to 40,000 tokens");
        expect(idleNotice({ minutes: 56, tokensBefore: undefined, tokensAfter: 1 })).not.toContain("tokens)");
    });
});
