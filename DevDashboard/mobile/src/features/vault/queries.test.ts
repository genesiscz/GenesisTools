import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { appendText, clipLink, looksLikeLink, qaNoteTarget, qaNoteText } from "@/features/vault/queries";

describe("send to my vault", () => {
    it("clips a link and appends text through the real client", async () => {
        const clip = await clipLink(fixtureDashboardClient, { url: "https://blog.example/post", idempotencyKey: "k1" });
        const append = await appendText(fixtureDashboardClient, { text: "x", idempotencyKey: "k2" });

        expect(clip).toMatchObject({ kind: "page", error: null });
        expect(append.note).toContain("Inbox/");
    });

    it("words a Q→A answer as a note section and files it under its project", () => {
        const text = qaNoteText({ question: "Why the cache?\nmore", answerMd: "Because.", project: "shop", ts: "2026-10-01" });

        expect(text).toBe("## Why the cache?\n\nshop · 2026-10-01\n\nBecause.\n");
        expect(qaNoteTarget("shop")).toEqual({ folder: "Inbox/shop", name: "Answers" });
        expect(qaNoteTarget(null)).toEqual({ name: "Answers" });
        expect(looksLikeLink(" https://a.example/x ")).toBe(true);
        expect(looksLikeLink("not a link")).toBe(false);
    });
});
