import { afterEach, describe, expect, test } from "bun:test";
import {
    CLOSED_BUG_TYPES,
    type ClosedBugContext,
    closedBugCodeLine,
    closedBugComment,
    closedBugFacts,
    closedBugOf,
    closedBugSummary,
    fixLocation,
} from "@app/gitlab/lib/closed-bug";
import { DEFAULT_CONFIG } from "@app/gitlab/lib/config";
import { setDateStyle } from "@app/gitlab/lib/dates";
import { createMessages } from "@app/gitlab/lib/messages";
import {
    addedLines,
    isSignificantLine,
    labelConflicts,
    overallVerdict,
    pickReleaseRef,
    refVerdict,
    type ShippedFacts,
    type ShippedRefCheck,
    type ShippedRoles,
} from "@app/gitlab/lib/shipped";
import type { AdoWorkItem } from "@app/gitlab/lib/work-items";

const MERGE_LABELS = DEFAULT_CONFIG.stale.mergeLabelPattern;

describe("addedLines", () => {
    test("keeps distinct significant added lines and drops headers, braces and removals", () => {
        const diff = [
            "--- a/x.tsx",
            "+++ b/x.tsx",
            "@@ -1,2 +1,3 @@",
            '+import { Tone } from "@acme/ui";',
            "+}",
            "+  <Banner tone={Tone.SECONDARY}>",
            "-  <Banner>",
            "+  <Banner tone={Tone.SECONDARY}>",
            "+// 1234567890123",
        ].join("\n");

        expect(addedLines(diff)).toEqual(["<Banner tone={Tone.SECONDARY}>"]);
        expect(isSignificantLine("   })   ")).toBe(false);
        expect(isSignificantLine("// 1234567890123")).toBe(false);
        expect(isSignificantLine("const x = 1;")).toBe(true);
    });

    test("imports, re-exports, bare JSX tags and closing punctuation are not evidence", () => {
        expect(isSignificantLine('import { View } from "react-native";')).toBe(false);
        expect(isSignificantLine('export { useFoo } from "./useFoo";')).toBe(false);
        expect(isSignificantLine('export * from "./types";')).toBe(false);
        expect(isSignificantLine("export const useFoo = () => 1;")).toBe(true);
        expect(isSignificantLine("</DialogContent>")).toBe(false);
        expect(isSignificantLine("<DialogActions>")).toBe(false);
        expect(isSignificantLine("<Banner tone={Tone.SECONDARY}>")).toBe(true);
        expect(isSignificantLine("            });          ")).toBe(false);
    });

    test("import continuations, single JSX attributes and short properties are not evidence either", () => {
        expect(isSignificantLine("ProgressStepper,")).toBe(false);
        expect(isSignificantLine('} from "@acme/components";')).toBe(false);
        expect(isSignificantLine('startIcon={<CalendarIcon variant="16px" />}')).toBe(false);
        expect(isSignificantLine('variant="16px"')).toBe(false);
        expect(isSignificantLine('type: "PRODUCT",')).toBe(false);
        expect(isSignificantLine("onPressEvents: OrderResultCardOnPressEvents;")).toBe(true);
        expect(isSignificantLine("const isUploadWithinLimit = (files: UploadFile[], maxTotalSize: number) => {")).toBe(
            true
        );
        expect(isSignificantLine("return differenceInDays(new Date(reading.requestDate), userDate) <= 0;")).toBe(true);
    });
});

describe("verdicts", () => {
    test("refVerdict needs more than 80 % to be present, zero to be absent", () => {
        expect(refVerdict(0, 0)).toBe("unknown");
        expect(refVerdict(0, 5)).toBe("absent");
        expect(refVerdict(4, 5)).toBe("partial");
        expect(refVerdict(5, 6)).toBe("present");
        expect(refVerdict(78, 80)).toBe("present");
    });

    test("overallVerdict: any present wins, all absent is absent, unknown refs are ignored", () => {
        const ref = (verdict: "present" | "partial" | "absent" | "unknown") => ({
            ref: "r",
            matched: 0,
            sampled: 0,
            verdict,
        });

        expect(overallVerdict([ref("unknown")])).toBe("unknown");
        expect(overallVerdict([ref("absent"), ref("present")])).toBe("present");
        expect(overallVerdict([ref("absent"), ref("unknown")])).toBe("absent");
        expect(overallVerdict([ref("absent"), ref("partial")])).toBe("partial");
    });

    test("the production release branch is the newest dated one not in the future", () => {
        const refs = [
            "origin/main",
            "origin/release/2026-08-20",
            "origin/release/2026-09-10",
            "origin/release/2026-10-01",
            "origin/release/notes",
        ];

        expect(pickReleaseRef(refs, "release/", "2026-09-23")).toBe("origin/release/2026-09-10");
        expect(pickReleaseRef(refs, "release/", "2026-08-01")).toBeNull();
        expect(pickReleaseRef(refs, "rel-", "2026-09-23")).toBeNull();
    });
});

describe("labelConflicts", () => {
    const facts = (developVerdict: "present" | "absent" | "unknown"): ShippedFacts => ({
        mergeBase: "abc",
        filesChanged: 1,
        insertions: 2,
        deletions: 1,
        refs: [
            { ref: "origin/staging", matched: 0, sampled: 2, verdict: "absent" },
            {
                ref: "origin/develop",
                matched: developVerdict === "present" ? 2 : 0,
                sampled: developVerdict === "unknown" ? 0 : 2,
                verdict: developVerdict,
            },
        ],
        files: [],
        verdict: "absent",
        note: null,
    });

    test("flags NOT merged when the content is present, and merged when it is absent", () => {
        expect(labelConflicts(["NOT merged into develop"], facts("present"), MERGE_LABELS)).toEqual([
            'label "NOT merged into develop" but 2 of 2 sampled lines are in origin/develop',
        ]);
        expect(labelConflicts(["Merged into develop"], facts("absent"), MERGE_LABELS)).toEqual([
            'label "Merged into develop" but no sampled line of the branch is in origin/develop',
        ]);
        expect(labelConflicts(["NOT merged into develop", "blocked"], facts("absent"), MERGE_LABELS)).toEqual([]);
        expect(labelConflicts(["Merged into develop"], facts("unknown"), MERGE_LABELS)).toEqual([]);
    });

    test("the label convention is configurable", () => {
        expect(labelConflicts(["in:develop"], facts("absent"), "^()in:(\\S+)$")).toEqual([
            'label "in:develop" but no sampled line of the branch is in origin/develop',
        ]);
    });
});

const UAT = "origin/staging";
const PROD = "origin/release/2026-09-10";
const TEST = "origin/develop";
const ROLES: ShippedRoles = { uat: UAT, production: PROD, test: TEST };
const PROJECT = "acme/web-app";

function context(language: "en" | "cs" = "en", roles: ShippedRoles = ROLES): ClosedBugContext {
    return { roles, messages: createMessages(language), projectPath: PROJECT };
}

function ref(name: string, matched: number, sampled: number): ShippedRefCheck {
    const verdict =
        sampled === 0 ? "unknown" : matched === 0 ? "absent" : matched / sampled > 0.8 ? "present" : "partial";

    return { ref: name, matched, sampled, verdict };
}

function shipped(
    uat: [number, number],
    prod: [number, number],
    test: [number, number],
    extra: Partial<ShippedFacts> = {}
): ShippedFacts {
    return {
        mergeBase: "abc",
        filesChanged: 2,
        insertions: 8,
        deletions: 3,
        refs: [ref(UAT, ...uat), ref(PROD, ...prod), ref(TEST, ...test)],
        files: [],
        verdict: "partial",
        note: null,
        exhaustive: true,
        filesChecked: 2,
        ...extra,
    };
}

function bug(extra: Partial<AdoWorkItem> = {}): AdoWorkItem {
    return {
        id: 4242,
        title: "Totals stay stale after an edit",
        type: "Bug",
        state: "Closed",
        url: "https://dev.azure.com/acme/web/_workitems/edit/4242",
        assignee: "Bob Example",
        tags: [],
        created: "2025-04-14T22:02:55.74Z",
        changed: "2026-08-06T15:14:18.47Z",
        changedBy: "Bob Example",
        description: "",
        parentId: 4000,
        comments: [],
        lastCommentDate: null,
        closedDate: "2026-08-06T15:14:18.47Z",
        closedBy: "Bob Example",
        reason: "Moved out of state Testing",
        environment: "TEST",
        mergeRequestUrl: null,
        ...extra,
    };
}

const mrUrl = (iid: number) => `https://gitlab.example.com/${PROJECT}/-/merge_requests/${iid}`;

describe("fixLocation", () => {
    test("present on UAT is released", () => {
        expect(fixLocation(shipped([9, 10], [9, 10], [9, 10]), ROLES)).toBe("released");
    });

    test("test environment only is unreleased, even with one stray line on UAT", () => {
        expect(fixLocation(shipped([0, 2], [0, 2], [2, 2]), ROLES)).toBe("unreleased");
        expect(fixLocation(shipped([1, 8], [1, 8], [6, 8]), ROLES)).toBe("unreleased");
    });

    test("a real share on UAT below the present threshold is partial", () => {
        expect(fixLocation(shipped([5, 13], [5, 13], [5, 13]), ROLES)).toBe("partial");
        expect(fixLocation(shipped([3, 4], [3, 4], [3, 4]), ROLES)).toBe("partial");
    });

    test("absent everywhere is nowhere, and so is a single stray line", () => {
        expect(fixLocation(shipped([0, 5], [0, 5], [0, 5]), ROLES)).toBe("nowhere");
        expect(fixLocation(shipped([1, 49], [1, 49], [1, 49]), ROLES)).toBe("nowhere");
    });

    test("nothing sampled or no check is unknown", () => {
        expect(fixLocation(shipped([0, 0], [0, 0], [0, 0]), ROLES)).toBe("unknown");
        expect(fixLocation(null, ROLES)).toBe("unknown");
    });

    test("with only a production branch configured, present there is released", () => {
        const onlyMain: ShippedRoles = { uat: null, production: "origin/main", test: null };
        const facts: ShippedFacts = { ...shipped([0, 0], [0, 0], [0, 0]), refs: [ref("origin/main", 5, 5)] };

        expect(fixLocation(facts, onlyMain)).toBe("released");
        expect(fixLocation({ ...facts, refs: [ref("origin/main", 0, 5)] }, onlyMain)).toBe("nowhere");
    });
});

describe("closedBugOf", () => {
    const ado = (item: AdoWorkItem, effective = item) => ({
        id: item.id,
        source: "title" as const,
        item,
        effective,
        error: null,
        parentError: null,
    });

    test("a Closed Bug with a content check yields facts", () => {
        const facts = closedBugOf({ ado: ado(bug()), shipped: shipped([0, 2], [0, 2], [2, 2]) }, context());

        expect(facts?.fix).toBe("unreleased");
        expect(facts?.closedBy).toBe("Bob Example");
        expect(facts?.test).toEqual({ ref: TEST, matched: 2, sampled: 2, ratio: 1 });
    });

    test("an open item, another type, or no item yields null", () => {
        expect(closedBugOf({ ado: ado(bug({ state: "Testing" })), shipped: null }, context())).toBeNull();
        expect(closedBugOf({ ado: ado(bug({ type: "Incident" })), shipped: null }, context())).toBeNull();
        expect(
            closedBugOf(
                { ado: ado(bug({ type: "Incident" })), shipped: null },
                { ...context(), types: ["Bug", "Incident"] }
            )?.type
        ).toBe("Incident");
        expect(closedBugOf({ ado: null, shipped: null }, context())).toBeNull();
        expect(CLOSED_BUG_TYPES).toEqual(["Bug"]);
    });

    test("a Task under a Closed Bug uses the parent", () => {
        const task = bug({ id: 4301, type: "Task", state: "Closed", title: "task" });

        expect(closedBugOf({ ado: ado(task, bug()), shipped: null }, context())?.adoId).toBe(4242);
    });
});

describe("closedBugComment (Czech catalog)", () => {
    afterEach(() => {
        setDateStyle("iso");
    });

    test("unreleased: lead sentence, code line per environment, the ask, no closing threat", () => {
        setDateStyle("dmy");
        const s = shipped([0, 2], [0, 2], [2, 2]);
        const text = closedBugFacts({ item: bug(), shipped: s, iid: 7101, context: context("cs") }).comment;

        expect(text.split("\n")[0]).toBe(
            "⚠️ Tenhle MR je stále otevřený, i když jeho [Bug - ADO 4242 - Totals stay stale after an edit](https://dev.azure.com/acme/web/_workitems/edit/4242) je už zavřený (6.8.2026, Bob Example)."
        );
        expect(text).toContain(
            "- Kód: MR přidává 8 řádků (2 soubory); porovnatelných řádků je 2: ve staging 0 (0 %), v release/2026-09-10 0 (0 %), na develop 2 (100 %)"
        );
        expect(text).toContain(
            "- [90%] Bug se zavřel po testu (prostředí v ADO: TEST), ale fix je jen na develop, do UAT ani do produkce se nedostal. Buď MR domergni do staging"
        );
        expect(text).not.toContain("zavřu");
    });

    test("partial names the files missing on UAT; a sample lowers the badge", () => {
        const s = shipped([5, 13], [5, 13], [5, 13], {
            exhaustive: true,
            files: [
                {
                    path: "a/Foo.tsx",
                    sampled: 8,
                    matched: {},
                    lines: [
                        { text: "x", in: [UAT] },
                        { text: "y", in: [] },
                        { text: "z", in: [] },
                    ],
                },
                { path: "b/Bar.ts", sampled: 5, matched: {}, lines: [{ text: "q", in: [] }] },
            ],
        });
        const facts = closedBugFacts({ item: bug(), shipped: s, context: context("cs") });

        expect(facts.missingFiles).toEqual([
            { path: "a/Foo.tsx", missing: 2, total: 3 },
            { path: "b/Bar.ts", missing: 1, total: 1 },
        ]);
        expect(closedBugCodeLine(facts, s, context("cs"))).toContain("; ve staging chybí Foo.tsx (2/3), Bar.ts (1/1)");
        const sampledShipped = { ...s, exhaustive: false };
        const sampled = closedBugFacts({ item: bug(), shipped: sampledShipped, context: context("cs") });

        expect(sampled.comment).toContain("[70%]");
        expect(closedBugCodeLine(sampled, sampledShipped, context("cs"))).toContain(", vzorek:");
    });

    test("nowhere, and the MR link recorded in the work item", () => {
        const s = shipped([0, 5], [0, 5], [0, 5]);
        const own = closedBugFacts({
            item: bug({ mergeRequestUrl: mrUrl(7102) }),
            shipped: s,
            iid: 7102,
            context: context("cs"),
        }).comment;

        expect(own).toContain("- V ADO je tenhle MR uvedený jako oprava.");
        expect(own).toContain("[85%] Bug je zavřený, ale tenhle fix není na develop, ve staging ani v produkci.");
        const other = closedBugFacts({
            item: bug({ mergeRequestUrl: mrUrl(7101) }),
            shipped: s,
            iid: 7103,
            context: context("cs"),
        }).comment;

        expect(other).toContain("- V ADO je jako oprava uvedený !7101.");
        const foreign = closedBugFacts({
            item: bug({ mergeRequestUrl: "https://gitlab.example.com/acme/other/-/merge_requests/3" }),
            shipped: s,
            iid: 7103,
            context: context("cs"),
        }).comment;

        expect(foreign).toContain(
            "- V ADO je jako oprava uvedený https://gitlab.example.com/acme/other/-/merge_requests/3."
        );
    });

    test("a diff of hundreds of files is unknown, with a code line that says so", () => {
        const s = shipped([3000, 30000], [3000, 30000], [3000, 30000], { filesChanged: 5000, insertions: 90000 });
        const facts = closedBugFacts({ item: bug(), shipped: s, iid: 7104, context: context("cs") });

        expect(facts.fix).toBe("unknown");
        expect(facts.huge).toBe(true);
        expect(facts.comment).toContain(
            "- Kód: MR má 5000 souborů (+90000 řádků), takže obsah nejde rozumně porovnat."
        );
        expect(facts.comment).toContain("- Napiš prosím, jestli je fix v produkci; z obsahu MR to nepoznám.");
        expect(closedBugSummary(facts)).toStartWith("unknown (huge diff);");
    });

    test("nothing comparable is unknown and asks instead of claiming", () => {
        const s = shipped([0, 0], [0, 0], [0, 0], {
            insertions: 1,
            filesChanged: 1,
            note: "no significant added lines to check",
        });
        const facts = closedBugFacts({ item: bug(), shipped: s, iid: 7105, context: context("cs") });

        expect(facts.fix).toBe("unknown");
        expect(facts.comment).toContain("- Kód: MR nepřidává řádky, které by šly porovnat, takže nevím, kde fix je.");
    });

    test("released says the MR can be closed", () => {
        const s = shipped([3, 3], [3, 3], [3, 3]);

        expect(closedBugFacts({ item: bug(), shipped: s, iid: 7106, context: context("cs") }).comment).toContain(
            "- [90%] Změna už je ve staging a bug je zavřený, MR jde zavřít."
        );
    });

    test("summary row for the table and the note", () => {
        setDateStyle("dmy");
        const s = shipped([0, 2], [0, 2], [2, 2]);

        expect(closedBugSummary(closedBugFacts({ item: bug(), shipped: s, context: context("cs") }))).toBe(
            "unreleased; staging 0/2, release/2026-09-10 0/2, develop 2/2; Closed 6.8.2026 by Bob Example"
        );
    });
});

describe("closedBugComment (English default)", () => {
    test("reads naturally with ISO dates and names the configured branches", () => {
        const s = shipped([0, 2], [0, 2], [2, 2]);
        const text = closedBugComment({
            facts: closedBugFacts({ item: bug(), shipped: s, context: context() }),
            shipped: s,
            iid: 1,
            context: context(),
        });

        expect(text.split("\n")[0]).toBe(
            "⚠️ This MR is still open, although its [Bug - ADO 4242 - Totals stay stale after an edit](https://dev.azure.com/acme/web/_workitems/edit/4242) is already closed (2026-08-06, Bob Example)."
        );
        expect(text).toContain(
            "- Code: the MR adds 8 lines (2 files); 2 comparable lines: staging 0 (0%), release/2026-09-10 0 (0%), develop 2 (100%)"
        );
        expect(text).toContain("the fix is only on develop and never reached staging");
    });

    test("with only production configured, the parts and the ask use it", () => {
        const roles: ShippedRoles = { uat: null, production: "origin/main", test: null };
        const s: ShippedFacts = { ...shipped([0, 0], [0, 0], [0, 0]), refs: [ref("origin/main", 0, 4)] };
        const facts = closedBugFacts({ item: bug(), shipped: s, context: context("en", roles) });

        expect(facts.fix).toBe("nowhere");
        expect(facts.comment).toContain("4 comparable lines: main 0 (0%)");
        expect(facts.comment).toContain("this fix is on none of main.");
    });
});
