import type { WaitingFormDto } from "@dd/contract";
import { beforeEach, describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { resetFixtureQueue } from "@/api/fixtures/queue";
import {
    answerForm,
    answerQueueKeys,
    answerQueueQuery,
    QUEUE_INTERVAL_MS,
    sendStaged,
    stagePick,
} from "@/features/answer-queue/queries";
import { formAnswers, missingAnswers, receiptOf, stagedOf, togglePick } from "@/features/answer-queue/units";

const client = fixtureDashboardClient;

async function queue() {
    const options = answerQueueQuery(client);
    return options.queryFn!({} as never);
}

describe("answer queue over the fixture wire (the real client)", () => {
    beforeEach(() => resetFixtureQueue());

    it("reads the waiting set grouped by session, with the notch total", async () => {
        const options = answerQueueQuery(client);
        expect([...options.queryKey]).toEqual([...answerQueueKeys.queue]);
        expect(options.refetchInterval).toBe(QUEUE_INTERVAL_MS);

        const data = await queue();
        expect(data.total).toBe(4);
        expect(data.sessions.map((session) => [session.sessionId, session.counted])).toEqual([
            ["s-parser", 3],
            ["s-docs", 1],
        ]);
    });

    it("stages a pick and a note, then sends them as one message with a receipt", async () => {
        await stagePick(client, { session: "s-parser", number: 4, option: "a", expectedRevision: 1, key: "k1" });
        await stagePick(client, { session: "s-parser", number: 4, text: "keep it warm", expectedRevision: 1, key: "k2" });
        const staged = stagedOf((await queue()).sessions[0]);
        expect(staged.map((item) => [item.number, item.draftOption, item.draft])).toEqual([[4, "a", "keep it warm"]]);

        const receipt = await sendStaged(client, { session: "s-parser", provider: "claude", key: "k3" });
        expect(receipt.kind).toBe("delivered");
        expect((await queue()).total).toBe(3);
    });

    it("refuses a stage on a revision the agent replaced, and a send with nothing staged", async () => {
        await expect(
            stagePick(client, { session: "s-parser", number: 4, option: "b", expectedRevision: 9, key: "k4" })
        ).rejects.toThrow("400");
        await expect(sendStaged(client, { session: "s-docs", key: "k5" })).rejects.toThrow("nothing to send");
    });

    it("answers an ask form, which leaves the queue", async () => {
        const form = (await queue()).sessions[0].items.find((item): item is WaitingFormDto => item.kind === "form");
        expect(form).toBeDefined();
        const draft = { q1: { selected: ["a"], text: "" } };
        expect(missingAnswers(form!, {})).toEqual(["q1"]);
        expect(missingAnswers(form!, draft)).toEqual([]);

        const receipt = await answerForm(client, { id: form!.id, answers: formAnswers(form!, draft), key: "k6" });
        expect(receipt.kind).toBe("delivered");
        expect((await queue()).sessions[0].items.some((item) => item.id === form!.id)).toBe(false);
    });
});

describe("answer queue rules", () => {
    it("never shows an uncertain send as delivered or queued", () => {
        expect(receiptOf({ delivered: true, uncertain: true, target: "pane 1" }).kind).toBe("uncertain");
        expect(receiptOf({ delivered: true, target: "pane 1" })).toEqual({ kind: "delivered", detail: "pane 1" });
        expect(receiptOf({ delivered: false, error: "no pane" })).toEqual({ kind: "queued", detail: "no pane" });
    });

    it("a single-choice question replaces its pick, a multiple one adds", () => {
        expect(togglePick(["a"], "b", false)).toEqual(["b"]);
        expect(togglePick(["a"], "b", true)).toEqual(["a", "b"]);
        expect(togglePick(["a", "b"], "a", true)).toEqual(["b"]);
    });
});
