import { describe, expect, test } from "bun:test";
import type { WordCheck } from "./languages/word-check";
import {
    applyFixes,
    candidatesInMeeting,
    findSuspectTerms,
    findUnknownWords,
    meetingTermCandidates,
    meetingTermsOf,
    scopedVocabulary,
} from "./terms";

const entry = (text: string) => ({ speaker: "Alice", startSec: 0, text });
const check: WordCheck = {
    provider: "fixture",
    language: "cs",
    verdict: (word) => ({
        class: ["komentu", "cloudu"].includes(word.toLowerCase()) ? "dictionary" : "unknown",
        count: 1,
    }),
    dispose() {},
};

describe("meeting term regressions", () => {
    test("Czech verbs cannot be glued to framework vocabulary", () => {
        expect(
            findSuspectTerms({
                entries: [entry("feature next je test")],
                vocab: [{ term: "Next.js", source: "context" }],
            }).map((item) => item.heard)
        ).not.toContain("next je");
    });

    test("known Czech words keep their language even when rare", () => {
        expect(
            findSuspectTerms({
                entries: [entry("do komentu a cloudu")],
                vocab: [
                    { term: "comments", source: "context" },
                    { term: "Claude", source: "context" },
                ],
                wordCheck: check,
            })
        ).toEqual([]);
    });

    test("a proposed loan phrase keeps its Czech plural ending", () => {
        const found = findSuspectTerms({
            entries: [entry("merge questy")],
            vocab: [{ term: "merge request", source: "context" }],
        });
        expect(found[0]?.candidates[0]?.term).toBe("merge requesty");
    });

    test("one explicit stem fix preserves five endings and rejects unrelated longer words", () => {
        const fix = {
            heard: "i na browser",
            replacement: "in-app browser",
            heardStem: "i na browser",
            proposedStem: "in-app browser",
        };
        const result = applyFixes(
            [entry("i na browser, i na browsera, i na browseru, i na browsery, i na browserem; i na browserovéx")],
            [fix]
        );
        expect(result.replaced).toBe(5);
        expect(result.entries[0]?.text).toBe(
            "in-app browser, in-app browsera, in-app browseru, in-app browsery, in-app browserem; i na browserovéx"
        );
    });

    test("an unknown acronym needs a correctly spoken meeting acronym", () => {
        const vocab = [{ term: "UAT", source: "context" }];
        const found = findUnknownWords({ entries: [entry("UAT a UAD a UADu")], vocab, wordCheck: check });
        expect(found.find((item) => item.heard === "UAD")?.candidates[0]).toMatchObject({
            term: "UAT",
            confidence: 80,
        });
        expect(found.find((item) => item.heard === "UADu")?.candidates[0]).toMatchObject({
            term: "UATu",
            confidence: 80,
        });
        expect(findUnknownWords({ entries: [entry("UAD")], vocab, wordCheck: check })[0]?.candidates).toEqual([]);
    });
});

test("scoped vocabulary contains only supplied meeting owners", () => {
    expect(scopedVocabulary({})).toEqual([]);
    expect(
        scopedVocabulary({ context: [{ term: "Maven", source: "context" }], people: ["Alice"] }).map(
            (item) => item.term
        )
    ).toEqual(["Maven", "Alice"]);
});

test("a one-edit unknown term gets the form spoken correctly in the same meeting", () => {
    const unknown: WordCheck = { ...check, verdict: () => ({ class: "unknown", count: 0 }) };
    const found = findUnknownWords({
        entries: [entry("Zephyr Zephxr")],
        vocab: [{ term: "Zephyr", source: "context" }],
        wordCheck: unknown,
    });
    expect(found.find((item) => item.heard === "Zephxr")?.candidates[0]).toMatchObject({
        term: "Zephyr",
        confidence: 80,
    });
});

test("an inflected known Czech stem produces no unknown item", () => {
    const known: WordCheck = {
        ...check,
        verdict: (word) => ({ class: word === "widget" ? "dictionary" : "unknown", count: 1 }),
    };
    expect(findUnknownWords({ entries: [entry("widgetem")], vocab: [], wordCheck: known })).toEqual([]);
});

test("observed acronym spellings are meeting scoped and preserve the ending", () => {
    const unknown: WordCheck = { ...check, verdict: () => ({ class: "unknown", count: 0 }) };
    const found = findUnknownWords({ entries: [entry("XYZ XYZ XYZko XYYku")], vocab: [], wordCheck: unknown });
    expect(found.find((item) => item.heard === "XYYku")?.candidates[0]).toMatchObject({
        term: "XYZku",
        confidence: 80,
    });
    expect(found.find((item) => item.heard === "XYZ")?.candidates).toEqual([]);
    expect(findUnknownWords({ entries: [entry("XYYku")], vocab: [], wordCheck: unknown })[0]?.candidates).toEqual([]);
});

test("the meeting is read once for every proposal, and a proposal from it equals one read for itself", () => {
    const entries = [entry("XYZ XYZ XYZko XYYku"), entry("Mluvili jsme o Kubernetes.")];
    const vocab = [{ term: "Kubernetes", source: "dictionary" }];
    const meeting = meetingTermsOf(entries, vocab);

    expect(meeting.acronyms).toEqual(
        new Map([
            ["XYZ", 3],
            ["XYY", 1],
        ])
    );
    expect(meeting.scoped.map((term) => term.term)).toEqual(["Kubernetes"]);

    for (const heard of ["XYYku", "Kubernetis", "XYZ"]) {
        expect(candidatesInMeeting(meeting, heard)).toEqual(meetingTermCandidates({ heard, entries, vocab }));
    }
});
