import type { DashboardClient, QaRow } from "@dd/contract";
import { QA_ANSWER_MAX_CHARS } from "@dd/lib/qa-clip";
import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import {
    appendText,
    clipLink,
    looksLikeLink,
    qaNoteTarget,
    qaNoteText,
    saveQaAnswer,
} from "@/features/vault/queries";

describe("send to my vault", () => {
    it("clips a link and appends text through the real client", async () => {
        const clip = await clipLink(fixtureDashboardClient, { url: "https://blog.example/post", idempotencyKey: "k1" });
        const append = await appendText(fixtureDashboardClient, { text: "x", idempotencyKey: "k2" });

        expect(clip).toMatchObject({ kind: "page", error: null });
        expect(append.note).toContain("Inbox/");
    });

    it("words a Q→A answer as a note section and files it under its project", () => {
        const text = qaNoteText({
            question: "Why the cache?\nmore",
            answerMd: "Because.",
            project: "shop",
            ts: new Date(2026, 9, 1, 14, 30).getTime(),
        });

        expect(text).toBe("## Why the cache?\n\nshop · 2026-10-01\n\nBecause.\n");
        expect(qaNoteTarget("shop")).toEqual({ folder: "Inbox/shop", name: "Answers" });
        expect(qaNoteTarget(null)).toEqual({ name: "Answers" });
        expect(looksLikeLink(" https://a.example/x ")).toBe(true);
        expect(looksLikeLink("not a link")).toBe(false);
    });

    it("saves the whole answer of an entry the feed clipped, and a short one as it is", async () => {
        const whole = "x".repeat(QA_ANSWER_MAX_CHARS + 10);
        const stored = { id: "qa-1", question: "Q", answerMd: whole, project: "shop", ts: 0 };
        const calls: { path: string; input: Record<string, unknown> }[] = [];
        const client = {
            call: async (endpoint: { path: string }, input: Record<string, unknown>) => {
                calls.push({ path: endpoint.path, input });
                return endpoint.path === "/api/qa/entry/:id" ? { entry: stored } : { note: "Inbox/shop/Answers" };
            },
        } as unknown as DashboardClient;
        const clipped = {
            ...stored,
            answerMd: whole.slice(0, QA_ANSWER_MAX_CHARS),
            answerFullChars: whole.length,
        } as unknown as QaRow;

        await saveQaAnswer(client, { entry: clipped, idempotencyKey: "k3" });
        expect(calls.map((call) => call.path)).toEqual(["/api/qa/entry/:id", "/api/vault/append"]);
        expect(calls[0].input).toEqual({ id: "qa-1" });
        expect(calls[1].input.text).toBe(qaNoteText(stored));

        calls.length = 0;
        await saveQaAnswer(client, { entry: { ...stored, answerMd: "short" } as unknown as QaRow, idempotencyKey: "k4" });
        expect(calls.map((call) => call.path)).toEqual(["/api/vault/append"]);
    });
});
