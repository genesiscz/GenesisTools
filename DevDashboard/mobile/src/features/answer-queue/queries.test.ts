import type { WaitingFormDto } from "@dd/contract";
import { beforeEach, describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { fixtureQueue, fixtureRepost, resetFixtureQueue } from "@/api/fixtures/queue";
import {
    answerForm,
    answerQueueKeys,
    answerQueueQuery,
    QUEUE_INTERVAL_MS,
    sendStaged,
    stagePick,
} from "@/features/answer-queue/queries";
import {
    flushDecision,
    flushThenSend,
    latestStage,
    singleFlight,
    formAnswers,
    keptEdits,
    keptOr,
    missingAnswers,
    pruneKept,
    stagesOf,
    noteStateOf,
    reconcileNote,
    RECENT_RECEIPTS_MAX,
    receiptOf,
    shownDrafts,
    stagedOf,
    togglePick,
    withRecentReceipt,
} from "@/features/answer-queue/units";

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

        const receipt = await sendStaged(client, {
            session: "s-parser",
            provider: "claude",
            drafts: shownDrafts((await queue()).sessions[0]),
            key: "k3",
        });
        expect(receipt.kind).toBe("delivered");
        expect((await queue()).total).toBe(3);
    });

    it("a send names the decisions the card shows, so a draft the queue hides stays staged", async () => {
        await stagePick(client, { session: "s-parser", number: 4, option: "a", expectedRevision: 1, key: "h1" });
        await stagePick(client, { session: "s-parser", number: 5, option: "b", expectedRevision: 1, key: "h2" });
        const session = (await queue()).sessions[0];
        // The card shows only DECISION 4 (DECISION 5 stands for a draft another surface staged on a hidden decision).
        const shown = { ...session, items: session.items.filter((item) => item.kind !== "decision" || item.number === 4) };
        expect(shownDrafts(shown)).toEqual([{ number: 4, expectedRevision: 1 }]);

        await sendStaged(client, { session: "s-parser", drafts: shownDrafts(shown), key: "h3" });
        const after = stagedOf((await queue()).sessions[0]);
        expect(after.map((item) => [item.number, item.draftOption])).toEqual([[5, "b"]]);
    });

    it("a re-post that clears one shown draft refuses the whole send, and the other draft stays staged", async () => {
        await stagePick(client, { session: "s-parser", number: 4, option: "a", expectedRevision: 1, key: "r1" });
        await stagePick(client, { session: "s-parser", number: 5, option: "b", expectedRevision: 1, key: "r2" });
        const shown = shownDrafts((await queue()).sessions[0]);
        // The agent posts DECISION 5 again while the phone still shows revision 1: its staged pick is cleared.
        fixtureRepost("s-parser", 5);

        await expect(sendStaged(client, { session: "s-parser", drafts: shown, key: "r3" })).rejects.toThrow(
            "DECISION 5 changed"
        );
        const after = stagedOf((await queue()).sessions[0]);
        expect(after.map((item) => [item.number, item.draftOption])).toEqual([[4, "a"]]);
    });

    it("clears a staged note with an empty string, so a send never carries the old text", async () => {
        await stagePick(client, { session: "s-parser", number: 4, option: "a", text: "old note", expectedRevision: 1, key: "c1" });
        await stagePick(client, { session: "s-parser", number: 4, text: "", expectedRevision: 1, key: "c2" });

        const staged = stagedOf((await queue()).sessions[0]);
        expect(staged.map((item) => [item.draftOption, item.draft])).toEqual([["a", null]]);
    });

    it("refuses a stage on a revision the agent replaced, and a send with nothing staged", async () => {
        await expect(
            stagePick(client, { session: "s-parser", number: 4, option: "b", expectedRevision: 9, key: "k4" })
        ).rejects.toThrow("400");
        const docs = (await queue()).sessions[1];
        await expect(sendStaged(client, { session: "s-docs", drafts: shownDrafts(docs), key: "k5" })).rejects.toThrow(
            "nothing to send"
        );
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
    it("a note follows a re-posted decision only while untouched; a changed note keeps the revision it was written on", () => {
        const shown = noteStateOf({ revision: 1, draft: null });
        const typed = { ...shown, note: "keep the cache" };

        expect(reconcileNote(shown, { revision: 2, draft: "from the hub" })).toEqual({
            note: "from the hub",
            base: { revision: 2, draft: "from the hub" },
        });
        expect(reconcileNote(typed, { revision: 2, draft: null })).toEqual(typed);
        expect(reconcileNote(typed, { revision: 1, draft: null })).toBe(typed);
    });

    it("a failed pick in flight stops the send until a later pick succeeds", async () => {
        const stage = latestStage();
        const refused = Promise.reject(new Error("DECISION 4 changed"));
        stage.track(refused);
        let sent = 0;

        expect(await flushThenSend([() => stage.settled()], () => sent++)).toBe(false);

        stage.track(Promise.resolve());
        expect(await flushThenSend([() => stage.settled()], () => sent++)).toBe(true);
        expect(sent).toBe(1);
    });

    it("a failed note save does not keep Send blocked: the next Send retries the note", async () => {
        const pick = latestStage();
        const note = latestStage();
        note.track(Promise.reject(new Error("network down")));
        let saves = 0;
        let sent = 0;
        const flush = () =>
            flushDecision({
                pick,
                note,
                saveNote: async () => {
                    saves++;
                },
            });

        expect(await flushThenSend([flush], () => sent++)).toBe(true);
        expect([saves, sent]).toEqual([1, 1]);

        // A failed pick still blocks, whatever the note does.
        pick.track(Promise.reject(new Error("DECISION 4 changed")));
        expect(await flushThenSend([flush], () => sent++)).toBe(false);
        expect(sent).toBe(1);
    });

    it("a second Send tap while the first still flushes does nothing", async () => {
        const once = singleFlight();
        let sends = 0;
        let release = () => {};
        const slow = new Promise<void>((resolve) => (release = resolve));

        const first = once(async () => {
            await slow;
            sends++;
        });
        const second = await once(async () => {
            sends++;
        });
        release();

        expect(second).toBe(false);
        expect(await first).toBe(true);
        expect(sends).toBe(1);
        expect(await once(async () => {})).toBe(true);
    });

    it("send waits for a slow note save, and a refused save stops the send", async () => {
        const order: string[] = [];
        const slowSave = () =>
            new Promise<void>((resolve) =>
                setTimeout(() => {
                    order.push("saved");
                    resolve();
                }, 10)
            );

        expect(await flushThenSend([slowSave], () => order.push("sent"))).toBe(true);
        expect(order).toEqual(["saved", "sent"]);

        const refused = async () => {
            throw new Error("DECISION 3 changed");
        };
        expect(await flushThenSend([refused], () => order.push("sent again"))).toBe(false);
        expect(order).toEqual(["saved", "sent"]);
    });

    it("an edit a card holds survives the card's unmount, and leaves with its item", () => {
        resetFixtureQueue();
        const sessions = fixtureQueue().sessions;
        const kept = keptEdits();
        const typed = { note: "half a thought", base: { revision: 1, draft: "" } };
        kept.notes.set("d_4", typed);
        kept.forms.set("ask_fixture", { q1: { selected: ["a"], text: "" } });

        // The list recycled the card: a remount reads the kept edit, not a fresh one.
        expect(keptOr(kept.notes, "d_4", () => ({ note: "", base: { revision: 1, draft: "" } }))).toBe(typed);
        expect(keptOr(kept.notes, "d_5", () => ({ note: "", base: { revision: 1, draft: "" } })).note).toBe("");

        pruneKept(kept, sessions);
        expect(kept.notes.has("d_4")).toBe(true);
        expect(kept.forms.has("ask_fixture")).toBe(true);

        // DECISION 4 and the form left the queue: their edits go with them.
        pruneKept(kept, sessions.slice(1));
        expect(kept.notes.has("d_4")).toBe(false);
        expect(kept.forms.has("ask_fixture")).toBe(false);
    });

    it("a refused pick still blocks Send after the card remounts, until a later pick is accepted", async () => {
        resetFixtureQueue();
        const sessions = fixtureQueue().sessions;
        const kept = keptEdits();
        const saveNote = async () => {};

        // First mount: pick a is staged, pick b is refused by the Mac.
        const first = stagesOf(kept, "d_4");
        first.pick.track(Promise.resolve());
        const refused = Promise.reject(new Error("DECISION 4 changed: the agent posted a new text"));
        refused.catch(() => undefined);
        first.pick.track(refused);
        await expect(flushDecision({ pick: first.pick, note: first.note, saveNote })).rejects.toThrow("changed");

        // The list unmounted the card and mounted it again: the new card asks the same screen store.
        const second = stagesOf(kept, "d_4");
        expect(second).toBe(first);
        await expect(flushDecision({ pick: second.pick, note: second.note, saveNote })).rejects.toThrow("changed");

        // A later pick the Mac accepts clears the block, as on a card that never unmounted.
        const accepted = Promise.resolve();
        second.pick.track(accepted);
        await accepted;
        await expect(flushDecision({ pick: second.pick, note: second.note, saveNote })).resolves.toBeUndefined();

        // The trackers leave with their decision, so a store never holds a failure for an item no longer shown.
        pruneKept(kept, sessions.slice(1));
        expect(kept.stages.has("d_4")).toBe(false);
        expect(stagesOf(kept, "d_4")).not.toBe(first);
    });

    it("keeps recent receipts newest first, one per card, and drops the oldest past the cap", () => {
        const entry = (testID: string, kind: "delivered" | "uncertain" = "delivered") => ({
            testID,
            label: testID,
            receipt: { kind, detail: null },
        });
        let list = withRecentReceipt([], entry("a"));
        list = withRecentReceipt(list, entry("b"));
        list = withRecentReceipt(list, entry("a", "uncertain"));

        expect(list.map((kept) => [kept.testID, kept.receipt.kind])).toEqual([
            ["a", "uncertain"],
            ["b", "delivered"],
        ]);

        for (let index = 0; index < RECENT_RECEIPTS_MAX + 2; index++) {
            list = withRecentReceipt(list, entry(`n${index}`));
        }

        expect(list).toHaveLength(RECENT_RECEIPTS_MAX);
        expect(list[0].testID).toBe(`n${RECENT_RECEIPTS_MAX + 1}`);
    });

    it("never shows an uncertain send as delivered or queued", () => {
        expect(receiptOf({ delivered: true, uncertain: true, target: "pane 1" }).kind).toBe("uncertain");
        expect(receiptOf({ delivered: true, target: "pane 1" })).toEqual({ kind: "delivered", detail: "pane 1" });
        expect(receiptOf({ delivered: false, error: "no pane" })).toEqual({ kind: "queued", detail: "no pane" });
    });

    it("a single-choice question replaces its pick, a multiple one adds", () => {
        expect(togglePick({ selected: ["a"], choice: "b", multiple: false })).toEqual(["b"]);
        expect(togglePick({ selected: ["a"], choice: "b", multiple: true })).toEqual(["a", "b"]);
        expect(togglePick({ selected: ["a", "b"], choice: "a", multiple: true })).toEqual(["b"]);
    });
});
