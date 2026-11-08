import { describe, expect, test } from "bun:test";
import type { InboxDecision } from "@app/question/lib/inbox/build";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { answerText, DecisionItem, draftedAnswers, sendLabel, toggleLetter } from "./QaDecisionsTab";

describe("several-letter decisions on the /qa decisions tab", () => {
    const choices = ["peg", "hand-written", "regex"].map((label, index) => ({
        id: String.fromCharCode(97 + index),
        label,
        rationale: null,
        recommended: false,
    }));
    const decision = (patch: Partial<InboxDecision>): InboxDecision => ({
        kind: "decision",
        id: "d_1_s-parsers",
        number: 1,
        title: null,
        prompt: "Which parsers?",
        choices,
        recommended: null,
        multiple: true,
        askedIn: null,
        blocking: false,
        status: "waiting",
        option: null,
        answer: null,
        answeredVia: null,
        source: "store",
        at: "2026-11-04T14:50:00.000Z",
        context: null,
        notes: null,
        proposal: null,
        reasoning: null,
        confidence: null,
        excerpt: null,
        refs: [],
        draftOption: null,
        draft: null,
        delivery: null,
        revision: 1,
        ...patch,
    });

    test("toggling letters builds the set in option order", () => {
        const item = decision({});

        expect(toggleLetter(item, undefined, "c")).toBe("c");
        expect(toggleLetter(item, "c", "a")).toBe("ac");
        expect(toggleLetter(item, "ac", "c")).toBe("a");
        expect(toggleLetter(item, "a", "a")).toBe("");
    });

    test("Send names the set, and a single choice keeps the count", () => {
        const item = decision({});
        const single = decision({ multiple: false });

        expect(sendLabel(draftedAnswers({ 1: { option: "ac", text: "" } }), [item])).toBe("Send a + c");
        expect(sendLabel(draftedAnswers({ 1: { option: "a", text: "" } }), [single])).toBe("Send 1 answer");
        expect(sendLabel(draftedAnswers({ 1: { option: "ac", text: "" }, 2: { option: "b", text: "" } }), [item])).toBe(
            "Send 2 answers"
        );
    });

    test("the answered line lists every chosen letter with its label", () => {
        expect(answerText(decision({ option: "ac", status: "answered" }))).toBe("a) peg, c) regex");
        expect(answerText(decision({ multiple: false, option: "b", status: "answered" }))).toBe("b) hand-written");
    });

    test("check boxes for a set, one-pick buttons for a single choice", () => {
        const several = renderToStaticMarkup(
            createElement(DecisionItem, { item: decision({}), draft: { option: "ac", text: "" }, onDraft: () => {} })
        );
        const single = renderToStaticMarkup(
            createElement(DecisionItem, {
                item: decision({ multiple: false }),
                draft: { option: "a", text: "" },
                onDraft: () => {},
            })
        );

        expect(several.match(/role="checkbox"/g)).toHaveLength(3);
        expect(several.match(/aria-checked="true"/g)).toHaveLength(2);
        expect(several).toContain("Pick any set");
        expect(several.match(/☑/g)).toHaveLength(2);
        expect(single).not.toContain('role="checkbox"');
        expect(single).not.toContain("☐");
        expect(single.match(/aria-pressed="true"/g)).toHaveLength(1);
    });

    test("a sub-agent's decision names its thread and its lead; a session no thread started names none", () => {
        const askedIn = "Review of the cache PR, a sub-agent of Overnight lead";
        const sub = renderToStaticMarkup(
            createElement(DecisionItem, { item: decision({ askedIn }), draft: { text: "" }, onDraft: () => {} })
        );
        const own = renderToStaticMarkup(
            createElement(DecisionItem, { item: decision({}), draft: { text: "" }, onDraft: () => {} })
        );

        expect(sub).toContain(`asked in ${askedIn}`);
        expect(own).not.toContain("asked in");
    });
});
