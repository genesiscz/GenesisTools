import { describe, expect, test } from "bun:test";
import { parseDecisionBlocks } from "./read";
import { findRefs, isFooterLine, recommendedLetterIn, stripRecommendation } from "./reply-text";

describe("stripRecommendation", () => {
    test("(recommended) and (My recommendation, because …) are removed and the reason kept", () => {
        expect(stripRecommendation("Keep the cache (recommended)")).toEqual({
            label: "Keep the cache",
            recommended: true,
            rationale: null,
        });
        expect(stripRecommendation("No change (My recommendation, because it costs nothing.)")).toEqual({
            label: "No change",
            recommended: true,
            rationale: "because it costs nothing",
        });
        expect(stripRecommendation("Add the registry line")).toEqual({
            label: "Add the registry line",
            recommended: false,
            rationale: null,
        });
    });

    test("Recommended: as a leading tag", () => {
        expect(stripRecommendation("Recommended: drop it")).toMatchObject({ label: "drop it", recommended: true });
    });
});

describe("recommendedLetterIn", () => {
    test("a sentence naming the letter", () => {
        expect(recommendedLetterIn("I recommend b) because it is reversible")).toBe("b");
        expect(recommendedLetterIn("Recommended: c)")).toBe("c");
        expect(recommendedLetterIn("no clear pick here")).toBeNull();
    });
});

describe("findRefs", () => {
    test("file paths with a line and a range, each once, and not a clock or a ratio", () => {
        const refs = findRefs(
            "See `src/app/main.ts:21` and .gitignore:6, and the block src/app/main.ts:21 again, and lib/x.ts:10-40. Not 22:31 or 3:4."
        );
        expect(refs).toEqual([
            { path: "src/app/main.ts", line: 21, endLine: null },
            { path: ".gitignore", line: 6, endLine: null },
            { path: "lib/x.ts", line: 10, endLine: 40 },
        ]);
    });

    test("an absolute path", () => {
        expect(findRefs("crash in /Users/x/app/Sources/View.swift:812 today")).toEqual([
            { path: "/Users/x/app/Sources/View.swift", line: 812, endLine: null },
        ]);
    });
});

describe("isFooterLine", () => {
    test("the graft tally and the STE100 line are footers", () => {
        expect(isFooterLine("🌱 graft saved 0 tokens this turn (0 calls).")).toBe(true);
        expect(isFooterLine("STE100 is on.")).toBe(true);
        expect(isFooterLine("The new files are not committed.")).toBe(false);
    });
});

describe("parseDecisionBlocks with context, rationale and recommended", () => {
    const REPLY = [
        "## ✅ DONE: why it failed",
        "",
        "- [95%] The worktree had no `.npmrc`, so bun used `~/.npmrc` (`.gitignore:6`).",
        "- [90%] `bunfig.toml:3` pins the CEZ bundle.",
        "",
        "❓ DECISION 1: Prevent this drift?",
        "- **a)** No change. Use `acme-tools worktree init`. (My recommendation, because it costs nothing.)",
        "- **b)** Add the registry line to `bunfig.toml`.",
        "- **c)** Fail fast with a preinstall check.",
        "",
        "🌱 graft saved 0 tokens this turn (0 calls).",
    ].join("\n");

    test("the question is the marker tail, not the footer; context, rationale and recommended are kept", () => {
        const [block] = parseDecisionBlocks(REPLY);

        expect(block?.prompt).toBe("Prevent this drift?");
        expect(block?.options).toEqual([
            "No change. Use `acme-tools worktree init`.",
            "Add the registry line to `bunfig.toml`.",
            "Fail fast with a preinstall check.",
        ]);
        expect(block?.recommended).toBe("a");
        expect(block?.rationales?.[0]).toBe("because it costs nothing");
        expect(block?.context).toContain("The worktree had no `.npmrc`");
        expect(block?.context).not.toContain("graft saved");
        expect(block?.notes).toBeUndefined();
    });

    test("a bare footer line after the options is never the prompt (the real 1271efea bug)", () => {
        const reply = [
            "Yes, the format does not change the token cost.",
            "",
            "❓ DECISION 1: The new files are not committed.",
            "- **a)** I commit only my files.",
            "- **b)** You review them first.",
            "",
            "🌱 graft saved 0 tokens this turn (0 calls).",
        ].join("\n");
        const [block] = parseDecisionBlocks(reply);

        expect(block?.prompt).toBe("The new files are not committed.");
        expect(block?.options).toEqual(["I commit only my files.", "You review them first."]);
        expect(block?.context).toContain("token cost");
    });

    test("the first block gets the preamble; a later block gets only the text between them", () => {
        const reply = [
            "Findings paragraph one.",
            "",
            "❓ DECISION 1: First?",
            "- a) yes",
            "- b) no",
            "",
            "A note that leads to the second decision.",
            "",
            "❓ DECISION 2: Second?",
            "- a) go",
            "- b) stop",
        ].join("\n");
        const [first, second] = parseDecisionBlocks(reply);

        expect(first?.context).toBe("Findings paragraph one.");
        expect(second?.context).toBe("A note that leads to the second decision.");
    });

    test("a recommendation line under the options sets recommended and becomes the notes", () => {
        const reply = [
            "❓ DECISION 3: Keep it?",
            "- a) keep",
            "- b) drop",
            "Recommended: a) because the cache is warm.",
        ].join("\n");
        const [block] = parseDecisionBlocks(reply);

        expect(block?.recommended).toBe("a");
        expect(block?.notes).toContain("Recommended: a)");
    });
});
