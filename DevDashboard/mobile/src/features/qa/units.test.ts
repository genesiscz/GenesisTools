import { describe, expect, it } from "bun:test";
import {
    answerPreview,
    DASH,
    isAnswerTruncated,
    isUnread,
    relativeTime,
    tagTone,
} from "@/features/qa/units";

describe("isAnswerTruncated / answerPreview", () => {
    it("treats <=3 lines as not truncated and returns them whole", () => {
        expect(isAnswerTruncated("a\nb\nc")).toBe(false);
        expect(answerPreview("a\nb\nc")).toBe("a\nb\nc");
    });

    it("truncates a >3-line answer to 3 lines + ellipsis", () => {
        expect(isAnswerTruncated("1\n2\n3\n4")).toBe(true);
        expect(answerPreview("1\n2\n3\n4")).toBe("1\n2\n3\n…");
    });

    it("returns the dash for a missing answer", () => {
        expect(answerPreview(undefined)).toBe(DASH);
        expect(isAnswerTruncated(undefined)).toBe(false);
    });
});

describe("relativeTime", () => {
    const now = 1_000_000_000_000;

    it("shows 'now' under 45s", () => {
        expect(relativeTime(now - 10_000, now)).toBe("now");
    });

    it("shows minutes, hours, then days", () => {
        expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
        expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
        expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
    });

    it("returns the dash for a missing/NaN ts", () => {
        expect(relativeTime(undefined, now)).toBe(DASH);
        expect(relativeTime(Number.NaN, now)).toBe(DASH);
    });
});

describe("tagTone", () => {
    it("maps tags to tones", () => {
        expect(tagTone("question")).toBe("muted");
        expect(tagTone("action")).toBe("accent");
        expect(tagTone("directive")).toBe("danger");
        expect(tagTone(undefined)).toBe("muted");
    });
});

describe("isUnread", () => {
    it("is unread when readAt is null/undefined, read otherwise", () => {
        expect(isUnread({ readAt: null })).toBe(true);
        expect(isUnread({ readAt: undefined as unknown as number })).toBe(true);
        expect(isUnread({ readAt: 123 })).toBe(false);
    });
});
