import { describe, expect, test } from "bun:test";
import { parseAnchor, parseJudgements } from "./judgements";
import { type CheckInput, checkJudgements, type KnownItem, skeletonText } from "./judgements-check";
import { parseUnifiedDiff } from "./pr-review";

const KNOWN: KnownItem[] = [
    {
        id: "T01",
        kind: "T",
        pair: { kind: "discussion", value: "0539a97f00000000000000000000000000000000" },
        path: "src/lock.ts",
        line: 3,
        body: "The lock stays off while a browser is open",
        author: "filip",
    },
    {
        id: "D01",
        kind: "D",
        pair: { kind: "draft", value: "22970" },
        path: "src/lock.ts",
        line: 2,
        body: "Is this still needed?",
        author: "me",
    },
];

const FILES = parseUnifiedDiff(
    [
        "diff --git a/src/lock.ts b/src/lock.ts",
        "--- a/src/lock.ts",
        "+++ b/src/lock.ts",
        "@@ -1,3 +1,4 @@",
        " const a = 1;",
        "+const b = 2;",
        " if (open) {",
        "+    return;",
    ].join("\n")
);

const RULES = {
    bannedWords: [{ word: "kontrakt", instead: "interface" }],
    forbidDashes: true,
    ownThreadForbidden: ["máš pravdu"],
};

function check(text: string): ReturnType<typeof checkJudgements> {
    const input: CheckInput = { judgements: parseJudgements(text), known: KNOWN, files: FILES, rules: RULES };

    return checkJudgements(input);
}

const GOOD = [
    "# MR !42 · give · head 0123456789",
    "- Overall: Approve with comments",
    "",
    "# T01 The lock stays off · discussion 0539a97f · src/lock.ts:3",
    "- Verdict: Valid [95%]",
    "- Proposal: Accept",
    "- Rationale:",
    "  - The guard returns early: src/lock.ts:3",
    "  - Second bullet",
    "- Action: reply",
    "- Proposed draft reply:",
    "",
    "```markdown",
    "Dobrej catch, opravím to.",
    "```",
    "",
    "# N01 Early return skips the cleanup",
    "- Severity: ⚠️ should fix",
    "- Anchor: src/lock.ts:4 (new) `    return;`",
    "- Verdict: Bug [85%]",
    "- Proposal: Post anchored draft",
    "- Action: comment",
    "- Proposed draft comment:",
    "",
    "```markdown",
    "Tady se vrací dřív, než proběhne úklid.",
    "```",
    "",
    "# Checked and fine",
    "",
    "- The rename is mechanical.",
].join("\n");

describe("judgements", () => {
    test("a filled file parses into header, items with fields, bullets and fences, and free sections", () => {
        const parsed = parseJudgements(GOOD);
        const t01 = parsed.items[0];

        expect(parsed.header.get("Overall")).toBe("Approve with comments");
        expect(parsed.items.map((item) => item.id)).toEqual(["T01", "N01"]);
        expect(t01.pair).toEqual({ kind: "discussion", value: "0539a97f" });
        expect(t01.fields.get("Verdict")).toBe("Valid [95%]");
        expect(t01.bullets.get("Rationale")).toEqual(["The guard returns early: src/lock.ts:3", "Second bullet"]);
        expect(t01.fences.get("Proposed draft reply")).toBe("Dobrej catch, opravím to.");
        expect(parsed.sections.get("Checked and fine")).toBe("- The rename is mechanical.");
    });

    test("a complete file passes the check", () => {
        expect(check(GOOD)).toEqual({ errors: [], warnings: [] });
    });

    test("the skeleton parses back, and its untouched blocks are warnings, not errors", () => {
        const skeleton = skeletonText({ iid: 42, mode: "give", headSha: "0123456789abcdef", items: KNOWN });
        const result = check(skeleton);

        expect(skeleton).toContain(
            "# T01 The lock stays off while a browser is open · discussion 0539a97f0000 · src/lock.ts:3"
        );
        expect(result.errors).toEqual([]);
        expect(result.warnings.map((w) => w.id)).toEqual(["T01", "D01"]);
    });

    test("a missing badge, a wrong action and an empty text are errors", () => {
        const broken = GOOD.replace("Valid [95%]", "Valid").replace("- Action: comment", "- Action: post");
        const messages = check(broken).errors.map((e) => `${e.id}: ${e.message}`);

        expect(messages).toContain("T01: the verdict needs its confidence badge, e.g. `Valid [85%]`");
        expect(messages).toContain('N01: Action must be one of comment, none, got "post"');
        expect(check(GOOD.replace("Dobrej catch, opravím to.", "")).errors[0]?.message).toBe(
            'Action reply sends "Proposed draft reply"; it is empty'
        );
    });

    test("an anchor whose line text differs is refused, with where that text really is", () => {
        const offByOne = GOOD.replace("src/lock.ts:4 (new) `    return;`", "src/lock.ts:3 (new) `    return;`");

        expect(check(offByOne).errors[0]?.message).toBe(
            "src/lock.ts:3 (new) is `if (open) {`, not `return;`; that text is at line 4"
        );
        expect(check(GOOD.replace("src/lock.ts:4 (new) `    return;`", "src/lock.ts:4 (new)")).errors[0]?.message).toBe(
            "copy the line's text into the anchor: src/lock.ts:4 (new) `return;`"
        );
    });

    test("a heading pair that no longer matches the MR is refused", () => {
        expect(check(GOOD.replace("discussion 0539a97f", "discussion ffff0000")).errors[0]?.message).toContain(
            "the heading says discussion ffff0000, but T01 is discussion 0539a97f0000 now"
        );
    });

    test("the configured house rules hold for text that goes to the MR", () => {
        const text = GOOD.replace("Dobrej catch, opravím to.", "Kontrakt se rozbije — opravím.");
        const messages = check(text).errors.map((e) => e.message);

        expect(messages).toContain("Proposed draft reply: no em or en dash; use a period, comma, colon or parentheses");
        expect(messages).toContain('Proposed draft reply: "kontrakt" is banned; write interface');
    });

    test("an answer in my own thread has no hand-written Opus prefix and no second person", () => {
        const answer = [
            "# D01 Is this still needed · draft 22970 · src/lock.ts:2",
            "- Verdict on the comment: Answered by the code [90%]",
            "- Action: keep",
            "- Proposed answer:",
            "",
            "```markdown",
            "[90%] Opus: Máš pravdu, je to potřeba.",
            "```",
        ].join("\n");
        const messages = check(answer).errors.map((e) => e.message);

        expect(messages).toContain(
            'Proposed answer: leave out "[NN%] Opus:"; the render and the post add it from the badge'
        );
        expect(messages).toContain(
            'Proposed answer: "máš pravdu" addresses nobody in your own thread; name the MR author or state it flat'
        );
    });

    test("a reply in my own thread sends the Proposed answer", () => {
        const reply = (text: string) =>
            [
                "# D01 Is this still needed · draft 22970 · src/lock.ts:2",
                "- Verdict on the comment: Still needed [80%]",
                "- Action: keep",
                "- Proposed answer:",
                "",
                "```markdown",
                text,
                "```",
            ].join("\n");
        const yours: KnownItem = { ...KNOWN[1], id: "Y01", kind: "Y", pair: { kind: "discussion", value: "abc" } };
        const input = (text: string): CheckInput => ({
            judgements: parseJudgements(
                reply(text).replace("# D01", "# Y01").replace("draft 22970", "discussion abc").replace("keep", "reply")
            ),
            known: [yours],
            files: FILES,
            rules: RULES,
        });

        expect(checkJudgements(input("Je to potřeba kvůli cache.")).errors).toEqual([]);
        expect(checkJudgements(input("")).errors[0]?.message).toBe('Action reply sends "Proposed answer"; it is empty');
    });

    test("anchors parse from the one documented form", () => {
        expect(parseAnchor("src/a.ts:44 (old) `x = 1`")).toEqual({
            path: "src/a.ts",
            line: 44,
            side: "old",
            text: "x = 1",
            top: false,
        });
        expect(parseAnchor("top")).toMatchObject({ top: true });
        expect(typeof parseAnchor("src/a.ts line 44")).toBe("string");
    });
});
