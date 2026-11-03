import { describe, expect, it } from "bun:test";
import { FakeTelegramMessagesApi } from "@genesiscz/utils/telegram-bot/lib/fake-messages-api";
import {
    MESSAGE_MEMORY_TTL_MS,
    postTelegramMessage,
    recallMessage,
    retractTelegramNotice,
} from "@genesiscz/utils/telegram-bot/lib/messages";
import { answerPress, createCallbackRouter } from "./callbacks";

const CHAT = 4242;

describe("postTelegramMessage", () => {
    it("returns the message id and remembers a notice, so another call can retract it", async () => {
        const api = new FakeTelegramMessagesApi();
        const posted = await postTelegramMessage({
            api,
            chatId: CHAT,
            text: "DECISION 3",
            buttons: [[{ text: "a", data: "d:tok-a" }]],
            noticeId: "notice-post-1",
        });

        expect(posted).toMatchObject({ chat: CHAT, message: 1 });
        expect(await recallMessage("notice-post-1")).toMatchObject({ chat: CHAT, message: 1 });
        expect(api.messages[0].buttons).toEqual([[{ text: "a", data: "d:tok-a" }]]);

        expect(await retractTelegramNotice({ api, noticeId: "notice-post-1", text: "DECISION 3 · answered" })).toBe(
            true
        );
        expect(api.messages[0]).toMatchObject({ text: "DECISION 3 · answered", buttons: [] });
        expect(await recallMessage("notice-post-1")).toBeNull();
    });

    it("cannot retract a notice it never posted", async () => {
        expect(await retractTelegramNotice({ api: new FakeTelegramMessagesApi(), noticeId: "never", text: "x" })).toBe(
            false
        );
    });

    it("forgets a notice past the memory's TTL", async () => {
        const api = new FakeTelegramMessagesApi();
        await postTelegramMessage({ api, chatId: CHAT, text: "old", noticeId: "notice-old", now: 1_000 });

        expect(await recallMessage("notice-old", 1_000 + MESSAGE_MEMORY_TTL_MS + 1)).toBeNull();
    });
});

describe("callback router", () => {
    const router = createCallbackRouter({
        d: async (_press, payload) => ({ toast: `picked ${payload}`, edit: { text: `answered with ${payload}` } }),
        boom: async () => {
            throw new Error("handler failed");
        },
    });

    it("dispatches by the prefix before the first colon and passes the rest", async () => {
        expect(await router.route({ id: "q1", data: "d:abc:def", chatId: CHAT })).toEqual({
            toast: "picked abc:def",
            edit: { text: "answered with abc:def" },
        });
    });

    it("answers an unknown prefix and a failing handler instead of throwing", async () => {
        expect((await router.route({ id: "q2", data: "zz:1", chatId: CHAT })).toast).toContain("no longer handled");
        expect((await router.route({ id: "q3", data: "nocolon", chatId: CHAT })).toast).toContain("no longer handled");
        expect((await router.route({ id: "q4", data: "boom:1", chatId: CHAT })).toast).toContain("did not work");
    });

    it("answerPress answers the query and edits the pressed message without its buttons", async () => {
        const api = new FakeTelegramMessagesApi();
        const posted = await postTelegramMessage({
            api,
            chatId: CHAT,
            text: "pick one",
            buttons: [[{ text: "a", data: "d:a" }]],
        });

        await answerPress({ api, router, press: { id: "q5", data: "d:a", chatId: CHAT, messageId: posted.message } });

        expect(api.answered).toEqual([{ id: "q5", text: "picked a" }]);
        expect(api.messages[0]).toMatchObject({ text: "answered with a", buttons: [] });
    });
});
