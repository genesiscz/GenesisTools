import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { judgementsToJson, parseAnchor, parseJudgements, parseJudgementsFile, reportPathFor } from "./judgements";
import { type CheckInput, checkJudgements, checkLines, type KnownItem, skeletonText } from "./judgements-check";
import { parseUnifiedDiff } from "./pr-review";

const KNOWN: KnownItem[] = [
    {
        id: "T01",
        kind: "T",
        pair: { kind: "discussion", value: "0539a97f00000000000000000000000000000000" },
        path: "src/lock.ts",
        line: 3,
        body: "The lock stays off while a browser is open",
        author: "bob",
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
    "- src/lock.ts: the rename is mechanical.",
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
        expect(parsed.sections.get("Checked and fine")).toBe("- src/lock.ts: the rename is mechanical.");
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
        expect(result.warnings.map((w) => w.id)).toEqual(["T01", "D01", "file"]);
        expect(skeleton).toContain("# Gates\n\n| Gate | Exit code |");
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

    test("a bare file name is not linked, and a changed file missing from Checked and fine is named", () => {
        const bare = GOOD.replace("  - Second bullet", "  - lock.ts:3 returns early").replace(
            "- src/lock.ts: the rename is mechanical.",
            "- The rename is mechanical."
        );
        const messages = check(bare).warnings.map((w) => w.message);

        expect(messages).toContain("`lock.ts:3` is not linked: write the repository path `src/lock.ts:3`");
        expect(messages).toContain(
            "`# Checked and fine` does not name 1 changed file(s): src/lock.ts (one bullet per file: what you checked in it)"
        );
    });

    test("a heading pair that no longer matches the MR is refused", () => {
        expect(check(GOOD.replace("discussion 0539a97f", "discussion ffff0000")).errors[0]?.message).toContain(
            "the heading says discussion ffff0000, but T01 is discussion 0539a97f0000 now"
        );
    });

    test("a judged item needs its pair, of the right kind, and a draft id matches only in full", () => {
        expect(check(GOOD.replace(" · discussion 0539a97f", "")).errors[0]?.message).toContain(
            "the heading lost its `discussion …` pair"
        );
        expect(check(GOOD.replace("discussion 0539a97f", "draft 0539")).errors[0]?.message).toContain(
            "the heading says draft 0539, but T01 is discussion"
        );

        const draft = [
            "# D01 Is this still needed · draft 2297 · src/lock.ts:2",
            "- Verdict on the comment: Wrong [90%]",
            "- Action: delete",
        ].join("\n");

        expect(check(draft).errors[0]?.message).toContain("the heading says draft 2297, but D01 is draft 22970");
        expect(check(draft.replace("draft 2297 ", "draft 22970 ")).errors).toEqual([]);
    });

    test("the rendered report goes beside the judgements file, never over it", () => {
        expect(reportPathFor("notes/MR42-judgements.md")).toBe("notes/MR42-report.md");
        expect(reportPathFor("notes/MR42-judgements.json")).toBe("notes/MR42-report.md");
        expect(reportPathFor("notes/MR42.JSON")).toBe("notes/MR42-report.md");
        expect(reportPathFor("notes/MR42")).toBe("notes/MR42-report.md");
    });

    test("the configured house rules hold for text that goes to the MR", () => {
        const text = GOOD.replace("Dobrej catch, opravím to.", "Kontrakt se rozbije — opravím.");
        const messages = check(text).errors.map((e) => e.message);

        expect(messages).toContain("Proposed draft reply: no em or en dash; use a period, comma, colon or parentheses");
        expect(messages).toContain('Proposed draft reply: "kontrakt" is banned; write interface');
    });

    test("a local file link never goes to the MR, with or without the file:// scheme", () => {
        const problem =
            "Proposed draft reply: no local file link in text that goes to the MR; name the path in backticks";

        for (const link of [
            "[a.ts:3](/work/app/a.ts#L3)",
            "[a.ts:3](file:///work/app/a.ts#L3)",
            "[notes](</work/notes>)",
            "[secret](/work/-/secret)",
        ]) {
            const text = GOOD.replace("Dobrej catch, opravím to.", `Dobrej catch, ${link} opravím.`);

            expect(check(text).errors.map((e) => e.message)).toContain(problem);
        }

        for (const link of [
            "![shot](/uploads/abc123/shot.png)",
            "[MR 4](/group/app/-/merge_requests/4)",
            "[MR 4](</group/app/-/merge_requests/4>)",
            "[commit](/group/sub/app/-/commit/abc123)",
        ]) {
            const text = GOOD.replace("Dobrej catch, opravím to.", `Dobrej catch, ${link} opravím.`);

            expect(check(text).errors.map((e) => e.message)).not.toContain(problem);
        }
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
        const result = check(answer);
        const ownThread =
            'Proposed answer: "máš pravdu" addresses nobody in your own thread; name the MR author or state it flat';

        expect(result.errors.map((e) => e.message)).toEqual([
            'Proposed answer: leave out "[NN%] Opus:"; the render and the post add it from the badge',
        ]);
        expect(result.warnings.map((w) => w.message)).toContain(ownThread);
    });

    test("a file written for another MR is refused as a whole", () => {
        const input = (text: string): CheckInput => ({
            judgements: parseJudgements(text),
            known: KNOWN,
            files: FILES,
            rules: RULES,
            iid: 42,
        });

        expect(checkJudgements(input(GOOD)).errors).toEqual([]);
        expect(checkJudgements(input(GOOD.replace("# MR !42", "# MR !43"))).errors).toEqual([
            {
                id: "file",
                line: 1,
                message: "this file was written for !43, not !42; run `review skeleton` for !42",
            },
        ]);
        expect(parseJudgementsFile(SafeJSON.stringify({ mr: 43, items: [] }), "x.json").mr).toBe(43);
    });

    test("a move is checked at its Move to line, never at a leftover Anchor", () => {
        const move = [
            "# D01 Is this still needed · draft 22970 · src/lock.ts:2",
            "- Verdict on the comment: Misplaced [80%]",
            "- Anchor: src/lock.ts:4 (new) `    return;`",
            "- Action: move",
            "- Move to: src/lock.ts:2 (new) `not this text`",
        ].join("\n");

        expect(check(move).errors[0]?.message).toContain("src/lock.ts:2 (new) is `const b = 2;`");
    });

    test("a move may keep the draft's text: no rewording needed", () => {
        const move = [
            "# D01 Is this still needed · draft 22970 · src/lock.ts:2",
            "- Verdict on the comment: Misplaced [80%]",
            "- Action: move",
            "- Move to: src/lock.ts:4 (new) `    return;`",
            "- Proposed rewording:",
            "",
            "```markdown",
            "```",
        ].join("\n");

        expect(check(move).errors).toEqual([]);
    });

    test("a reply whose text holds a table row or an `a | b` is not an unfilled placeholder", () => {
        const table = GOOD.replace("Dobrej catch, opravím to.", "| před | po |\n| --- | --- |\n| a | b |");

        expect(check(table).errors).toEqual([]);
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
        const yours: KnownItem = { ...KNOWN[1], id: "Y01", kind: "Y", pair: { kind: "discussion", value: "abc123" } };
        const input = (text: string): CheckInput => ({
            judgements: parseJudgements(
                reply(text)
                    .replace("# D01", "# Y01")
                    .replace("draft 22970", "discussion abc123")
                    .replace("keep", "reply")
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

/** What a judgements file means, for comparing a hand-edited copy with the original. */
function meaning(text: string, path = "judgements.md") {
    const parsed = parseJudgementsFile(text, path);

    return {
        header: Object.fromEntries(parsed.header),
        items: parsed.items
            .map((item) => ({
                id: item.id,
                pair: item.pair,
                fields: Object.fromEntries([...item.fields].filter(([, value]) => value !== "")),
                bullets: Object.fromEntries(item.bullets),
                fences: Object.fromEntries(item.fences),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
    };
}

describe("a judgements file edited by hand", () => {
    const original = meaning(GOOD);
    const errorsOf = (text: string, path?: string) =>
        checkJudgements({
            judgements: parseJudgementsFile(text, path),
            known: KNOWN,
            files: FILES,
            rules: RULES,
        }).errors.map((e) => `${e.id}: ${e.message}`);
    const warningsOf = (text: string) =>
        checkJudgements({ judgements: parseJudgements(text), known: KNOWN, files: FILES, rules: RULES }).warnings.map(
            (w) => `${w.id}: ${w.message}`
        );

    const repaired: Array<[string, (text: string) => string]> = [
        ["Windows line ends", (t) => t.replace(/\n/g, "\r\n")],
        ["a byte-order mark", (t) => `﻿${t}`],
        ["item headings at level 2", (t) => t.replace("# T01", "## T01").replace("# N01", "### N01")],
        ["a lower-case, unpadded id", (t) => t.replace("# T01 ", "# t1 ")],
        [
            "keys in bold",
            (t) =>
                t.replace("- Verdict: Valid", "- **Verdict:** Valid").replace("- Action: reply", "- **Action**: reply"),
        ],
        [
            "star and plus bullets",
            (t) =>
                t.replace("- Verdict: Valid", "* Verdict: Valid").replace("- Proposal: Accept", "+ Proposal: Accept"),
        ],
        ["a lower-case key", (t) => t.replace("- Verdict: Bug", "- verdict: Bug")],
        ["the action in backticks and capitals", (t) => t.replace("- Action: reply", "- Action: `Reply`")],
        [
            "a longer fence",
            (t) =>
                t
                    .replace("```markdown\nDobrej", "````markdown\nDobrej")
                    .replace("opravím to.\n```", "opravím to.\n````"),
        ],
        [
            "a tilde fence",
            (t) =>
                t.replace("```markdown\nDobrej", "~~~markdown\nDobrej").replace("opravím to.\n```", "opravím to.\n~~~"),
        ],
        [
            "the text indented by three spaces, as the render shows it",
            (t) => t.replace("\nDobrej catch", "\n   Dobrej catch"),
        ],
        ["blank lines and trailing spaces", (t) => t.replace(/\n/g, "  \n").replace("# N01", "\n\n# N01")],
        [
            "the items in another order",
            (t) => {
                const at = t.indexOf("# N01");
                const end = t.indexOf("# Checked");
                return (
                    t.slice(0, t.indexOf("# T01")) + t.slice(at, end) + t.slice(t.indexOf("# T01"), at) + t.slice(end)
                );
            },
        ],
        [
            "an edited title",
            (t) => t.replace("# T01 The lock stays off ·", "# T01 Lock off while the browser is open ·"),
        ],
        [
            "rationale bullets indented by a tab",
            (t) => t.replace("  - The guard", "\t- The guard").replace("  - Second", "\t- Second"),
        ],
        [
            "an HTML comment between fields",
            (t) => t.replace("- Proposal: Accept", "<!-- checked twice -->\n- Proposal: Accept"),
        ],
    ];

    for (const [name, mutate] of repaired) {
        test(`reads the same after: ${name}`, () => {
            expect(meaning(mutate(GOOD))).toEqual(original);
            expect(errorsOf(mutate(GOOD))).toEqual([]);
        });
    }

    test("a reply left as plain lines, not in a fence, is read and reported", () => {
        const plain = GOOD.replace("```markdown\nDobrej catch, opravím to.\n```", "Dobrej catch, opravím to.");

        expect(meaning(plain)).toEqual(original);
        expect(warningsOf(plain)).toContain(
            'T01: the text under "Proposed draft reply" is not in a fence; it is read as written'
        );
    });

    test("an alias key is read under its real name and reported", () => {
        const aliased = GOOD.replace("- Proposed draft reply:", "- Draft reply:");

        expect(meaning(aliased)).toEqual(original);
        expect(warningsOf(aliased)).toContain('T01: "Draft reply" read as "Proposed draft reply"');
    });

    test("a heading inside a closed reply fence is the reply's own text: a warning, not an error", () => {
        const withHeading = GOOD.replace("Dobrej catch, opravím to.", "Dobrej catch.\n\n## Explanation\n\nOpravím to.");

        expect(errorsOf(withHeading)).toEqual([]);
        expect(warningsOf(withHeading).some((w) => w.includes("its closing fence is probably missing"))).toBe(true);
    });

    test("an unclosed fence is an error, because everything after it would be posted", () => {
        const unclosed = GOOD.replace("opravím to.\n```", "opravím to.");

        expect(
            errorsOf(unclosed).some((e) => e.includes('holds the heading "# N01 Early return skips the cleanup"'))
        ).toBe(true);
        expect(errorsOf(GOOD.replace("Tady se vrací dřív, než proběhne úklid.\n```", "Tady se vrací dřív."))).toContain(
            'N01: the fence under "Proposed draft comment" is never closed, so everything after it would be posted'
        );
    });

    test("an id used twice, a changed discussion id and an unfilled action are errors", () => {
        expect(
            errorsOf(`${GOOD}\n\n# T01 Again · discussion 0539a97f\n- Verdict: Valid [90%]\n- Action: none`)
        ).toContain("T01: this id appears twice; merge the two blocks");
        expect(errorsOf(GOOD.replace("discussion 0539a97f", "discussion 0539a970"))[0]).toContain(
            "the heading says discussion 0539a970"
        );
        expect(errorsOf(GOOD.replace("- Action: reply", "- Action: reply | reply-resolve | none"))).toContain(
            'T01: Action must be one of reply, reply-resolve, none, got ""'
        );
    });

    test("a misspelled key is reported, and the item it leaves without a verdict is not judged", () => {
        const misspelled = GOOD.replace("- Verdict: Valid", "- Verdikt: Valid");

        expect(warningsOf(misspelled).some((w) => w.startsWith('T01: unknown field "Verdikt"'))).toBe(true);
        expect(warningsOf(misspelled)).toContain("T01: not judged (no verdict); it will be left out");
    });

    test("a heading that lost its id leaves the thread without a block, and says so", () => {
        expect(warningsOf(GOOD.replace("# T01 The lock", "# The lock"))).toContain(
            "T01: this thread has no block in the file"
        );
    });

    test("the JSON form reads the same, and broken JSON is repaired with a warning", () => {
        const json = SafeJSON.stringify(judgementsToJson(parseJudgements(GOOD)), null, 2);

        expect(meaning(json, "judgements.json")).toEqual(original);
        expect(errorsOf(json, "judgements.json")).toEqual([]);

        const broken = json.replace(/"\n(\s*)\}/, '",\n$1}');
        const parsed = parseJudgementsFile(broken, "judgements.json");

        expect(meaning(broken, "judgements.json")).toEqual(original);
        expect(parsed.warnings.map((w) => w.message)).toContain(
            "the JSON was broken and was repaired; check the texts read as meant"
        );
        expect(errorsOf("not json at all {", "judgements.json")[0]).toContain("the JSON needs an `items` array");
    });

    test("a JSON item with its fields at the top is read under the real names, and says so", () => {
        const flat = SafeJSON.stringify({
            items: [
                {
                    id: "N01",
                    verdict: "Bug [85%]",
                    action: "comment",
                    anchor: "src/lock.ts:4 (new) `    return;`",
                    "proposed draft comment": "Tady se vrací dřív.",
                    note: "scratch",
                },
            ],
        });
        const parsed = parseJudgementsFile(flat, "judgements.json");
        const n01 = parsed.items[0];

        expect(n01.fields.get("Verdict")).toBe("Bug [85%]");
        expect(n01.fields.get("Action")).toBe("comment");
        expect(n01.fences.get("Proposed draft comment")).toBe("Tady se vrací dřív.");
        expect(parsed.warnings.map((w) => `${w.severity} ${w.id}: ${w.message}`)).toEqual([
            'warning N01: "verdict" belongs under fields; read as "Verdict"',
            'warning N01: "action" belongs under fields; read as "Action"',
            'warning N01: "anchor" belongs under fields; read as "Anchor"',
            'warning N01: "proposed draft comment" belongs under texts; read as "Proposed draft comment"',
            'warning N01: unknown key "note"; it is ignored',
        ]);
        expect(errorsOf(flat, "judgements.json")).toEqual([]);
    });

    test("a field set both under fields and at the top keeps the fields value and says so", () => {
        const both = SafeJSON.stringify({
            items: [
                {
                    id: "N01",
                    fields: { Verdict: "Bug [85%]", Action: "comment" },
                    texts: { "Proposed draft comment": "Tady se vrací dřív." },
                    verdict: "Nit [40%]",
                    "proposed draft comment": "jiný text",
                },
            ],
        });
        const parsed = parseJudgementsFile(both, "judgements.json");

        expect(parsed.items[0].fields.get("Verdict")).toBe("Bug [85%]");
        expect(parsed.items[0].fences.get("Proposed draft comment")).toBe("Tady se vrací dřív.");
        expect(parsed.warnings.map((w) => w.message)).toEqual(
            expect.arrayContaining([
                '"verdict" is also set under fields; the fields value is kept and "verdict" is ignored',
                '"proposed draft comment" is also set under texts; the texts value is kept and "proposed draft comment" is ignored',
            ])
        );
    });

    test("a JSON value of the wrong type is an error, because its content would be lost", () => {
        const wrong = SafeJSON.stringify({
            overal: "Approve",
            sections: ["Checked and fine"],
            items: [
                {
                    id: "N01",
                    fields: "Verdict: Bug [85%]",
                    texts: ["Tady se vrací dřív."],
                    rationale: "because",
                },
                { id: "T01", pair: "discussion 0539a97f", fields: { Verdict: { text: "Valid" }, Action: "none" } },
            ],
        });

        expect(errorsOf(wrong, "judgements.json")).toEqual([
            "file: `sections` must be an object of title → text, got an array",
            "N01: `fields` must be an object of field name → text, got a string",
            "N01: `texts` must be an object of text field name → text, got an array",
            "N01: `rationale` must be an array of strings, got a string",
            'T01: field "Verdict" must be text, got an object',
        ]);
        expect(parseJudgementsFile(wrong, "judgements.json").warnings.map((w) => w.message)).toContain(
            'unknown key "overal"; it is ignored (the keys are: mr, mode, head, overall, items, sections)'
        );
    });

    test("a new finding with text but no verdict is reported, because it would be left out", () => {
        const unjudged = GOOD.replace("- Verdict: Bug [85%]\n", "");

        expect(warningsOf(unjudged)).toContain("N01: it has text but no verdict; it will be left out");
        expect(warningsOf(skeletonText({ iid: 42, mode: "give", headSha: "0123456789", items: KNOWN }))).not.toContain(
            "N01: it has text but no verdict; it will be left out"
        );
    });

    test("every door prints the same problem lines: warnings first, then errors with their line", () => {
        expect(
            checkLines({
                warnings: [
                    { id: "T01", line: 0, message: "this thread has no block in the file" },
                    { id: "N01", line: 7, message: "unknown field" },
                ],
                errors: [{ id: "file", line: 1, message: "the JSON needs an `items` array" }],
            })
        ).toEqual([
            "⚠  T01: this thread has no block in the file",
            "⚠  N01 (line 7): unknown field",
            "✗  file (line 1): the JSON needs an `items` array",
        ]);
    });
});
