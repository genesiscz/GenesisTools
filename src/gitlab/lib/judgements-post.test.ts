import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJudgements } from "./judgements";
import type { KnownItem } from "./judgements-check";
import {
    alreadyPosted,
    describeStep,
    ledgerPath,
    loadLedger,
    planPost,
    readBack,
    saveLedger,
    stepHash,
} from "./judgements-post";

const KNOWN: KnownItem[] = [
    {
        id: "T01",
        kind: "T",
        pair: { kind: "discussion", value: "aaaa1111" },
        path: "src/a.ts",
        line: 3,
        body: "Why?",
        author: "reviewer",
    },
    {
        id: "D01",
        kind: "D",
        pair: { kind: "draft", value: "900" },
        path: "src/a.ts",
        line: 2,
        body: "Old text",
        author: "me",
    },
    {
        id: "D02",
        kind: "D",
        pair: { kind: "draft", value: "901" },
        path: "src/a.ts",
        line: 5,
        body: "Remove me",
        author: "me",
    },
    {
        id: "D03",
        kind: "D",
        pair: { kind: "discussion", value: "bbbb2222" },
        publishedFrom: "902",
        path: "src/a.ts",
        line: 7,
        body: "Published question",
        author: "me",
    },
];

const block = (lines: string[]): string => lines.join("\n");

const FILE = block([
    "# MR !42 · give · head bbbbbbbbbb",
    "",
    "# T01 Why · discussion aaaa1111 · src/a.ts:3",
    "- Verdict: Valid [90%]",
    "- Action: reply-resolve",
    "- Proposed draft reply:",
    "",
    "```markdown",
    "Fixed.",
    "```",
    "",
    "# D01 Old text · draft 900 · src/a.ts:2",
    "- Verdict on the comment: Unclear [70%]",
    "- Action: reword",
    "- Proposed rewording:",
    "",
    "```markdown",
    "New text",
    "```",
    "",
    "# D02 Remove me · draft 901 · src/a.ts:5",
    "- Verdict on the comment: Wrong [90%]",
    "- Action: delete",
    "",
    "# D03 Published question · draft 902 · src/a.ts:7",
    "- Verdict on the comment: Answered by the code [80%]",
    "- Answer to the comment: Yes. [85%]",
    "- Action: delete",
    "- Proposed answer:",
    "",
    "```markdown",
    "Ano.",
    "```",
    "",
    "# N01 New finding",
    "- Anchor: src/a.ts:4 (old) `x`",
    "- Verdict: Bug [80%]",
    "- Action: comment",
    "- Proposed draft comment:",
    "",
    "```markdown",
    "Here.",
    "```",
    "",
    "# N02 Nothing to say",
    "- Verdict: Fine [60%]",
    "- Action: none",
]);

const plan = (ids: string[], answers: string[] = []) =>
    planPost({ judgements: parseJudgements(FILE), known: KNOWN, ids, answers, agent: "Opus" });

describe("comments post plan", () => {
    test("each item's Action becomes one step; none and keep are skipped", () => {
        const result = plan(["t01", "D01", "D02", "N01", "N02"]);

        expect(result.errors).toEqual([]);
        expect(result.skipped).toEqual([{ id: "N02", reason: "Action none" }]);
        expect(result.steps.map((step) => [step.id, step.kind])).toEqual([
            ["T01", "reply"],
            ["D01", "reword"],
            ["D02", "delete"],
            ["N01", "comment"],
        ]);
        expect(result.steps[0]).toMatchObject({ discussionId: "aaaa1111", body: "Fixed.", resolve: true });
        expect(result.steps[3]).toMatchObject({ anchor: { path: "src/a.ts", line: 4, side: "old" } });
        expect(describeStep(result.steps[0])).toBe('T01  reply+resolve thread aaaa1111 at src/a.ts:3  "Fixed."');
    });

    test("a published draft cannot be deleted any more, but its answer goes into the thread it became, signed", () => {
        expect(plan(["D03"]).errors).toEqual([
            { id: "D03", message: "the draft was published; answer in its thread with --answers D03" },
        ]);
        expect(plan([], ["D03"]).steps).toEqual([
            {
                id: "D03",
                kind: "reply",
                discussionId: "bbbb2222",
                body: "[85%] Opus: Ano.",
                resolve: false,
                where: "thread bbbb2222 at src/a.ts:7",
            },
        ]);
    });

    test("an unpublished draft has nobody to answer, and an unknown id is an error, not a skip", () => {
        const withAnswer = FILE.replace(
            "- Action: reword",
            "- Action: reword\n- Proposed answer:\n\n```markdown\nAno.\n```"
        );

        expect(
            planPost({
                judgements: parseJudgements(withAnswer),
                known: KNOWN,
                ids: [],
                answers: ["D01"],
                agent: "Opus",
            }).errors[0]?.message
        ).toBe("nobody can reply to an unpublished draft; publish the review first (`comments publish`)");
        expect(plan(["X01"]).errors).toEqual([{ id: "X01", message: "no block in the judgements file" }]);
    });

    test("the ledger skips a step that landed with the same text, and only that", () => {
        const path = ledgerPath(
            { host: "https://gitlab.example.com", project: "group/app", iid: 42 },
            mkdtempSync(join(tmpdir(), "gt-ledger-"))
        );
        const [reply] = plan(["T01"]).steps;

        if (reply.kind !== "reply") {
            throw new Error("expected a reply step");
        }

        saveLedger(path, { T01: { kind: "reply", bodyHash: stepHash(reply), at: "2026-10-07T05:00:00Z" } });
        const ledger = loadLedger(path);

        expect(alreadyPosted(ledger, reply)).not.toBeNull();
        expect(alreadyPosted(ledger, { ...reply, body: "Fixed, differently." })).toBeNull();
    });

    test("read back checks the effect GitLab shows, not the call's answer", () => {
        const [reply, reword, remove, comment] = plan(["T01", "D01", "D02", "N01"]).steps;
        const drafts = [
            { id: 1, discussionId: "aaaa1111", path: null, line: null, side: null, note: "Fixed." },
            { id: 900, discussionId: null, path: "src/a.ts", line: 2, side: "new" as const, note: "New text" },
            { id: 5, discussionId: null, path: "src/a.ts", line: 9, side: "old" as const, note: "Here." },
        ];
        const ids = new Map([
            ["D01", 900],
            ["N01", 5],
        ]);

        expect(readBack(reply, drafts, ids)).toBeNull();
        expect(readBack(reword, drafts, ids)).toBeNull();
        expect(readBack(remove, drafts, ids)).toBeNull();
        expect(readBack(remove, [...drafts, { ...drafts[1], id: 901 }], ids)).toBe("draft 901 is still pending");
        expect(readBack(comment, drafts, ids)).toBe("the draft sits at src/a.ts:9, not src/a.ts:4 (old)");
    });
});
