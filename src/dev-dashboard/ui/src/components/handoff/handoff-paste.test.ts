import { describe, expect, it } from "bun:test";
import { collectUploadTokens, insertAtCursor, type UploadedAttachment } from "./handoff-paste";

function fulfilled(attachmentId: string): PromiseFulfilledResult<UploadedAttachment> {
    return { status: "fulfilled", value: { attachmentId } };
}

function rejected(reason: unknown): PromiseRejectedResult {
    return { status: "rejected", reason };
}

describe("collectUploadTokens", () => {
    it("joins a [File#id] token for every fulfilled upload with no failure", () => {
        const { tokens, failure } = collectUploadTokens([fulfilled("a_1"), fulfilled("a_2")]);
        expect(tokens).toBe("[File#a_1] [File#a_2]");
        expect(failure).toBeUndefined();
    });

    it("keeps tokens for the successful uploads and surfaces the first rejection on mixed results", () => {
        const err = new Error("upload failed");
        const { tokens, failure } = collectUploadTokens([fulfilled("a_1"), rejected(err), fulfilled("a_2")]);
        expect(tokens).toBe("[File#a_1] [File#a_2]");
        expect(failure?.reason).toBe(err);
    });

    it("returns empty tokens and the failure when all uploads reject", () => {
        const err = new Error("boom");
        const { tokens, failure } = collectUploadTokens([rejected(err)]);
        expect(tokens).toBe("");
        expect(failure?.reason).toBe(err);
    });
});

describe("insertAtCursor", () => {
    it("splices the insert at the cursor", () => {
        expect(insertAtCursor("abcd", "X", 2)).toBe("abXcd");
    });

    it("clamps a stale cursor past the end of a shrunken draft (typed/submitted/switched mid-upload)", () => {
        // Draft was longer when the cursor was captured, then shrank while the
        // upload was in flight — the token must land at the end, not out of range.
        expect(insertAtCursor("ab", "[File#a_1]", 10)).toBe("ab[File#a_1]");
    });

    it("clamps a negative cursor to the start", () => {
        expect(insertAtCursor("ab", "X", -5)).toBe("Xab");
    });
});
