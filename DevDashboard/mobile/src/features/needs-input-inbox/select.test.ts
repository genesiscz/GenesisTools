import type { AttentionItem } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { fixtureQueue, resetFixtureQueue } from "@/api/fixtures/queue";
import {
    attentionCount,
    attentionItemTestId,
    inboxRowKey,
    inboxSections,
    partitionAttention,
    relativeTime,
} from "@/features/needs-input-inbox/select";

/** Pure inbox display logic (no React, no I/O). Mirrors qa's `live-feed`/`units` test shape. */

function item(id: string, kind: AttentionItem["kind"]): AttentionItem {
    const deepLink: AttentionItem["deepLink"] =
        kind === "agent-question" ? { kind: "qa", qaId: id } : { kind: "terminal", ttydTabId: id };
    return { id, kind, title: id, subtitle: "", ts: 0, deepLink };
}

describe("partitionAttention", () => {
    it("splits by kind, preserving order, and handles empty input", () => {
        const items = [
            item("qa:1", "agent-question"),
            item("ttyd:a", "agent-session"),
            item("qa:2", "agent-question"),
        ];
        const { questions, sessions } = partitionAttention(items);
        expect(questions.map((i) => i.id)).toEqual(["qa:1", "qa:2"]);
        expect(sessions.map((i) => i.id)).toEqual(["ttyd:a"]);

        const empty = partitionAttention([]);
        expect(empty.questions).toEqual([]);
        expect(empty.sessions).toEqual([]);
    });
});

describe("attentionCount", () => {
    it("is the item length", () => {
        expect(attentionCount([])).toBe(0);
        expect(attentionCount([item("qa:1", "agent-question"), item("ttyd:a", "agent-session")])).toBe(2);
    });
});

describe("attentionItemTestId", () => {
    it("sanitizes the namespaced colon into a hyphen", () => {
        expect(attentionItemTestId("qa:mock-1")).toBe("needs-input-inbox-item-qa-mock-1");
        expect(attentionItemTestId("ttyd:ttyd-1")).toBe("needs-input-inbox-item-ttyd-ttyd-1");
    });
});

describe("relativeTime", () => {
    it("buckets seconds/minutes/hours/days and guards bad input", () => {
        const now = 1_000_000_000;
        expect(relativeTime(now - 10_000, now)).toBe("now");
        expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
        expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
        expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
        expect(relativeTime(undefined, now)).toBe("—");
        expect(relativeTime(Number.NaN, now)).toBe("—");
    });
});

describe("inboxSections", () => {
    it("puts every queue session in the list's data, keyed as its card was, so only visible cards mount", () => {
        resetFixtureQueue();
        const sessions = fixtureQueue().sessions;
        const sections = inboxSections({ sessions, items: [item("qa:1", "agent-question")] });

        expect(sections.map((section) => section.key)).toEqual(["queue", "attention"]);
        expect(sections[0].data.map(inboxRowKey)).toEqual(["s-parser", "s-docs"]);
        expect(sections[1].data.map(inboxRowKey)).toEqual(["qa:1"]);
    });

    it("an empty attention list is one status row under its header; an empty queue has no rows", () => {
        const sections = inboxSections({ sessions: [], items: [] });

        expect(sections[0].data).toEqual([]);
        expect(sections[1].data).toEqual([{ kind: "status" }]);
        expect(inboxRowKey({ kind: "status" })).toBe("attention-status");
    });
});
