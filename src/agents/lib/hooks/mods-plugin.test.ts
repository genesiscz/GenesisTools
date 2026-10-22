import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    collapseGitSyncEnabled,
    fullDiffEnabled,
    gitSyncOf,
    isDeletion,
    OPEN_FILE_LINES,
    openByDefault,
    sectionsOf,
    sectionsOfCalls,
} from "../../../../plugins/genesis-tools-mods/hooks/sections";
import { overflowPart } from "./diff/full";
import { MOD_MAX_PATCH_CHARS, MODS_SESSION_VAR } from "./diff/run";

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

describe("the mod's session mark", () => {
    it("is the variable the diff hook reads", () => {
        const source = readFileSync(
            join(import.meta.dir, "../../../../plugins/genesis-tools-mods/hooks/register.tsx"),
            "utf8"
        );
        expect(source).toContain(`$.env.set("${MODS_SESSION_VAR}", id)`);
    });

    it("shares the hook's patch budget, so a call the mod cannot draw keeps its full-diff link", () => {
        const source = readFileSync(
            join(import.meta.dir, "../../../../plugins/genesis-tools-mods/hooks/register.tsx"),
            "utf8"
        );
        const budget = source.match(/const MAX_CHARS = ([\d_]+);/)?.[1]?.replaceAll("_", "");
        expect(Number(budget)).toBe(MOD_MAX_PATCH_CHARS);
    });
});

describe("the full-diff mod's note reader", () => {
    it("reads a file past the hook's file cap, headed with its counts by overflowPart", () => {
        const part = overflowPart("/repo/src/d.ts", "@@ -1,1 +1,2 @@\n-old\n+new\n+more");
        const note = ["# Diff of toolu_z", "", `## ${part.label}`, "", "```diff", part.patch, "```", ""].join("\n");

        expect(sectionsOf(note).map((section) => [section.path, section.added, section.removed])).toEqual([
            ["/repo/src/d.ts", 2, 1],
        ]);
    });

    it("counts an added or removed source line that itself starts with ++ or --", () => {
        const patch = ["--- a/src/c.c", "+++ b/src/c.c", "@@ -1,2 +1,2 @@", "---i;", "+++i;", " x"].join("\n");

        expect(overflowPart("/repo/src/c.c", patch).label).toBe("/repo/src/c.c (+1 -1)");
    });

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

        expect(all.sections.map((section) => `${section.call} ${section.path}`)).toEqual([
            "first /repo/src/a.ts",
            "first /repo/src/b.ts",
            "third /repo/src/a.ts",
            "third /repo/src/b.ts",
        ]);
        expect(all.omitted).toEqual([]);

        const cut = await sectionsOfCalls({ ids: ["first", "third"], read, maxChars: 40 });

        expect(cut.sections.map((section) => section.path)).toEqual(["/repo/src/a.ts"]);
    });

    it("names every call of a group whose files went past the shared budget", async () => {
        // Each call fits alone, so the hook dropped both links; together the second one was not drawn at all.
        const read = async () => NOTE;
        const one = (await sectionsOfCalls({ ids: ["first"], read, maxChars: 1_000 })).sections;
        const each = one.reduce((total, section) => total + section.patch.length, 0);
        const group = await sectionsOfCalls({ ids: ["first", "second", "third"], read, maxChars: each + 10 });

        expect(group.sections.map((section) => section.call)).toEqual(["first", "first"]);
        expect(group.omitted).toEqual(["second", "third"]);
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
        expect(collapseGitSyncEnabled('{"mods":{"fullDiff":false}}')).toBe(true);
        expect(collapseGitSyncEnabled('{"mods":{"collapseGitSync":false}}')).toBe(false);
    });

    it("names the git sync a command runs, and not one it only mentions", () => {
        expect(gitSyncOf("cd /r && git pull -q --ff-only 2>&1 | tail -2; git log -5")).toBe("git pull");
        expect(gitSyncOf("git -C /r stash pop")).toBe("git stash pop");
        expect(gitSyncOf("git rebase origin/master")).toBe("git rebase");
        expect(gitSyncOf("git log --oneline; git diff")).toBeUndefined();
        expect(gitSyncOf('git commit -m "after git pull"')).toBeUndefined();
        expect(gitSyncOf("git commit -F - <<'EOF'\ngit merge was clean\nEOF")).toBeUndefined();
        expect(gitSyncOf("tools git pullout")).toBeUndefined();
    });

    it("reads a quoted git folder as one argument, and no git sync a command only prints", () => {
        expect(gitSyncOf('git -C "/repo/a b" pull')).toBe("git pull");
        expect(gitSyncOf("git -c core.pager=cat --no-pager merge topic")).toBe("git merge");
        expect(gitSyncOf("echo git pull; perl -pi -e s/a/b/ a.ts")).toBeUndefined();
        expect(gitSyncOf("printf '%s' x && git status")).toBeUndefined();
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
