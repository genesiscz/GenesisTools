import type { AttentionItem } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import {
    attentionCount,
    attentionItemTestId,
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
