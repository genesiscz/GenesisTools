import { describe, expect, test } from "bun:test";
import { parseProposal } from "@app/hub/lib/proposal";
import { parseJudgements } from "./judgements";
import type { KnownItem } from "./judgements-check";
import {
    copyBlock,
    linkify,
    postedText,
    proposalFromJudgements,
    quote,
    type RenderContext,
    renderDigest,
    renderFull,
    renderItems,
} from "./judgements-render";
import { parseUnifiedDiff } from "./pr-review";

const LONG_COMMENT = [
    "On Android the retain is released through the AppState listener on the active transition.",
    "On iOS stopRetaining() is called at once.",
    "",
    "EDIT: confirmed, the lock stays off while the browser is open.",
].join("\n");

const KNOWN: KnownItem[] = [
    {
        id: "T01",
        kind: "T",
        pair: { kind: "discussion", value: "aaaa1111" },
        path: "src/lock.ts",
        line: 3,
        body: LONG_COMMENT,
        author: "reviewer",
    },
    {
        id: "D01",
        kind: "D",
        pair: { kind: "draft", value: "900" },
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

const CTX: RenderContext = {
    iid: 42,
    mode: "give",
    mr: {
        host: "https://gitlab.example.com",
        project: "group/app",
        title: "Tidy the lock",
        webUrl: "https://gitlab.example.com/group/app/-/merge_requests/42",
        sourceBranch: "feature/lock",
        targetBranch: "main",
        headSha: "b".repeat(40),
        baseSha: "a".repeat(40),
    },
    repoPath: "/nonexistent-checkout",
    known: KNOWN,
    threads: new Map([
        [
            "aaaa1111",
            {
                id: "aaaa1111",
                notes: [
                    {
                        author: { username: "reviewer" },
                        body: LONG_COMMENT,
                        position: { new_path: "src/lock.ts", new_line: 3 },
                    },
                ],
            },
        ],
    ]),
    threadOpts: null,
    drafts: [{ id: 900, discussionId: null, path: "src/lock.ts", line: 2, side: "new", note: "Is this still needed?" }],
    files: FILES,
    agent: "Opus",
};

const FILLED = [
    "# MR !42 · give · head bbbbbbbbbb",
    "- Overall: Approve with comments [80%]",
    "",
    "# T01 The lock stays off · discussion aaaa1111 · src/lock.ts:3",
    "- Verdict: Valid [95%]",
    "- Proposal: Accept",
    "- Action: reply",
    "- Proposed draft reply:",
    "",
    "```markdown",
    "Opravím to.",
    "",
    "Díky.",
    "```",
    "",
    "# D01 Is this still needed · draft 900 · src/lock.ts:2",
    "- Verdict on the comment: Answered by the code [90%]",
    "- Answer to the comment: Yes, the test needs it. [90%]",
    "- Action: delete",
    "- Proposed answer:",
    "",
    "```markdown",
    "Ano, test ho potřebuje.",
    "```",
    "",
    "# N01 Early return skips the cleanup",
    "- Severity: ⚠️ should fix",
    "- Anchor: src/lock.ts:4 (new) `    return;`",
    "- Verdict: Bug [85%]",
    "- Action: comment",
    "- Proposed draft comment:",
    "",
    "```markdown",
    "Tady se vrací dřív.",
    "```",
].join("\n");

describe("judgements render", () => {
    test("a quote keeps every line, blank lines included, and a copy block indents each line by three spaces", () => {
        expect(quote(LONG_COMMENT)).toBe(
            [
                "> On Android the retain is released through the AppState listener on the active transition.",
                "> On iOS stopRetaining() is called at once.",
                ">",
                "> EDIT: confirmed, the lock stays off while the browser is open.",
            ].join("\n")
        );
        expect(copyBlock("one\n\ntwo")).toBe("```markdown\n   one\n\n   two\n```");
    });

    test("an answer in my own thread is signed with its badge; other text is sent as written", () => {
        const [t01, d01] = parseJudgements(FILLED).items;

        expect(postedText(t01, "Opus")).toBe("Opravím to.\n\nDíky.");
        expect(postedText(d01, "Opus")).toBeNull();
        expect(postedText({ ...d01, fields: new Map([...d01.fields, ["Action", "keep"]]) }, "Opus")).toBeNull();
    });

    test("the digest quotes the comment in full and shows the exact text that would be posted", () => {
        const digest = renderDigest(parseJudgements(FILLED), CTX);

        expect(digest).toContain(quote(LONG_COMMENT));
        expect(digest).toContain("```markdown\n   Opravím to.\n\n   Díky.\n```");
        expect(digest).toContain(
            "**Answer, after the review is published:**\n\n```markdown\n   [90%] Opus: Ano, test ho potřebuje.\n```"
        );
        // A should-fix finding keeps its code in the digest.
        expect(digest).toContain("Code at the anchor (added line; old · new · kind):");
    });

    test("an excerpt shows 10 lines on each side of the anchor", () => {
        const long = parseUnifiedDiff(
            [
                "diff --git a/src/long.ts b/src/long.ts",
                "--- /dev/null",
                "+++ b/src/long.ts",
                "@@ -0,0 +1,30 @@",
                ...Array.from({ length: 30 }, (_, i) => `+const v${i + 1} = ${i + 1};`),
            ].join("\n")
        );
        const finding = [
            "# N01 Fifteen",
            "- Severity: ⚠️ should fix",
            "- Anchor: src/long.ts:15 (new) `const v15 = 15;`",
            "- Verdict: Bug [85%]",
            "- Action: comment",
            "- Proposed draft comment:",
            "",
            "```markdown",
            "Tady.",
            "```",
        ].join("\n");
        const full = renderFull(parseJudgements(finding), { ...CTX, files: long });

        expect(full).toContain("const v5 = 5;");
        expect(full).toContain("const v25 = 25;");
        expect(full).not.toContain("const v4 = 4;");
        expect(full).not.toContain("const v26 = 26;");
    });

    test("the full layout groups threads, my comments and new findings; --item picks blocks by id", () => {
        const full = renderFull(parseJudgements(FILLED), CTX);

        expect(full.indexOf("## Threads")).toBeLessThan(full.indexOf("## Part A · your comments"));
        expect(full.indexOf("## Part A · your comments")).toBeLessThan(full.indexOf("## Part B · new findings"));
        expect(full).toContain("**Your draft:**\n> Is this still needed?");
        expect(renderItems(parseJudgements(FILLED), CTX, ["n01", "X09"])).toContain(
            "_No block in the judgements file for: X09._"
        );
    });

    test("the proposal passes the review window's own parser", () => {
        const proposal = parseProposal(proposalFromJudgements(parseJudgements(FILLED), CTX));

        expect(proposal.verdict).toMatchObject({ decision: "comment", confidence: 80 });
        expect(proposal.drafts).toMatchObject([
            { id: "N01", path: "src/lock.ts", line: 4, side: "additions", severity: "major" },
        ]);
        expect(proposal.threads?.[0]).toMatchObject({
            threadId: "aaaa1111",
            verdict: "valid",
            confidence: 95,
            suggestedReply: "Opravím to.\n\nDíky.",
        });
    });

    test("a path:line becomes a link only when the file exists in the checkout", () => {
        expect(linkify("see src/lock.ts:3", "/nonexistent-checkout")).toBe("see src/lock.ts:3");
        expect(linkify("see package.json:1", process.cwd())).toContain("[package.json:1](file://");
    });
});
