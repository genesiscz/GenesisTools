import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ActDeps } from "@app/question/lib/act/act";
import { memoryActTokenStore } from "@app/question/lib/act/tokens";
import type { DecisionRecord } from "@app/question/lib/decisions/store";
import {
    CLOSED_ELSEWHERE,
    postDecisionsToTelegram,
    retractDecisionTelegramMessages,
} from "@app/question/lib/decisions/telegram";
import type { AnswerDecisionInput } from "@app/question/lib/inbox/answer";
import type { DraftInput } from "@app/question/lib/inbox/drafts";
import { setNoticeDeps } from "@app/question/lib/notices/notices";
import { memoryNoticeStore } from "@app/question/lib/notices/store";
import { FakeTelegramMessagesApi } from "@genesiscz/utils/telegram-bot/lib/fake-messages-api";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";
import { decisionPressHandler } from "./callback-routes";
import { answerPress, createCallbackRouter } from "./callbacks";

const CHAT = 7001;
const NOW = Date.parse("2026-11-03T10:00:00Z");

// Telegram delivery goes through postNotice, which posts nothing in a test process without notice deps.
beforeEach(() => {
    setNoticeDeps({
        store: memoryNoticeStore(),
        dispatch: async () => true,
        retract: async () => true,
        now: () => NOW,
    });
});
afterEach(() => setNoticeDeps(undefined));

const bot: TelegramBotConfig = {
    botToken: "100:fake-token-for-tests",
    chats: { commands: CHAT },
    configuredAt: "2026-01-01T00:00:00.000Z",
    decisions: { projects: { "repo-full": { text: true }, "repo-quiet": { text: false } } },
};

function decision(overrides: Partial<DecisionRecord>): DecisionRecord {
    return {
        id: "d_1_s-one",
        sessionId: "s-one",
        number: 1,
        prompt: "Ship the cache?\n\na) yes, now\nb) after the review",
        options: ["yes, now", "after the review"],
        recommended: "b",
        project: "repo-full",
        sessionTitle: "cache work",
        state: "open",
        updatedTs: "2026-11-03T09:00:00Z",
        ...overrides,
    };
}

describe("F11: decisions answered in Telegram", () => {
    it("posts opted-in projects only, with one button per letter, and the text only where it is allowed", async () => {
        const api = new FakeTelegramMessagesApi();
        const store = memoryActTokenStore();
        const posted = await postDecisionsToTelegram(
            [
                decision({ id: "d_1_s-one" }),
                decision({ id: "d_2_s-two", number: 2, sessionId: "s-two", project: "repo-quiet" }),
                decision({ id: "d_3_s-three", number: 3, sessionId: "s-three", project: "repo-off" }),
                decision({ id: "d_4_s-four", number: 4, sessionId: "s-four", for: "fable" }),
                decision({ id: "t_1_s-one", number: 1, type: "todo", for: "human" }),
            ],
            { bot, api, store, now: NOW }
        );

        expect(posted).toBe(2);
        expect(api.messages.map((message) => message.chat)).toEqual([CHAT, CHAT]);
        expect(api.messages[0].text).toContain("Ship the cache?");
        expect(api.messages[0].text).toContain("b) after the review");
        expect(api.messages[1].text).not.toContain("Ship the cache?");
        expect(api.messages[1].text).toContain("❓ DECISION 2");
        expect(api.messages[0].buttons[0].map((button) => button.text)).toEqual(["a", "b ★"]);
        expect(api.messages[0].buttons[0].every((button) => /^d:[A-Za-z0-9_-]{22}$/.test(button.data))).toBe(true);
        expect(Object.keys(store.tokens)).toHaveLength(4);
    });

    it("answers a press once, edits the message with the outcome, and returns the first receipt on Telegram's retry", async () => {
        const api = new FakeTelegramMessagesApi();
        const store = memoryActTokenStore();
        const row = decision({ id: "d_5_s-five", number: 5, sessionId: "s-five" });
        // Its own chat: the message memory is shared by the file, and another test's message 1 in CHAT would match.
        const own = { ...bot, chats: { commands: 7005 } };
        await postDecisionsToTelegram([row], { bot: own, api, store, now: NOW });

        const calls: AnswerDecisionInput[] = [];
        const actDeps: ActDeps = {
            store,
            rows: () => [row],
            answer: async (input) => {
                calls.push(input);
                return { session: "s-five", text: "5b", channel: "cmux", delivered: true, detail: "cmux · work" };
            },
        };
        const router = createCallbackRouter({
            d: decisionPressHandler({ actDeps: async () => actDeps, now: () => NOW + 1 }),
        });
        const [message] = api.messages;
        const press = { id: "cbq-1", data: message.buttons[0][1].data, chatId: 7005, messageId: message.message };

        await answerPress({ api, router, press });
        const edited = message.text;
        // Telegram's retry of the same press goes through the whole path, edit included.
        const retry = await answerPress({ api, router, press });

        expect(retry.edit).toBeUndefined();
        expect(message.text).toBe(edited);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ session: "s-five", number: 5, option: "b", deliveryKey: "telegram:cbq-1" });
        expect(api.answered).toEqual([
            { id: "cbq-1", text: "Sent b" },
            { id: "cbq-1", text: "Sent b" },
        ]);
        expect(message.text).toContain("Ship the cache?");
        expect(message.text).toContain("→ b sent to the agent (cmux · work)");
        expect(message.buttons).toEqual([]);
        expect(retry.toast).toBe("Sent b");
    });

    it("keeps a long decision under Telegram's limit, and one refused post does not stop the next", async () => {
        class RefusesFirst extends FakeTelegramMessagesApi {
            private refused = false;

            override async sendMessage(...args: Parameters<FakeTelegramMessagesApi["sendMessage"]>) {
                if (!this.refused) {
                    this.refused = true;
                    throw new Error("Bad Request: message is too long");
                }

                return super.sendMessage(...args);
            }
        }
        const api = new RefusesFirst();
        const long = "x".repeat(2000);
        const posted = await postDecisionsToTelegram(
            [
                decision({ id: "d_7_s-seven", number: 7, sessionId: "s-seven" }),
                decision({
                    id: "d_8_s-eight",
                    number: 8,
                    sessionId: "s-eight",
                    prompt: long.repeat(2),
                    options: [long, long, long],
                }),
            ],
            { bot, api, store: memoryActTokenStore(), now: NOW }
        );

        expect(posted).toBe(1);
        expect(api.messages).toHaveLength(1);
        expect(api.messages[0].text).toContain("❓ DECISION 8");
        expect(api.messages[0].text.length).toBeLessThanOrEqual(3800);
    });

    it("gives a pressed message back when the act fails, so the retraction still drops its buttons", async () => {
        // Its own chat: the message memory is shared by the file, and another test's message 1 in CHAT would match.
        const own = { ...bot, chats: { commands: 7009 } };
        const api = new FakeTelegramMessagesApi();
        const row = decision({ id: "d_9_s-nine", number: 9, sessionId: "s-nine" });
        await postDecisionsToTelegram([row], { bot: own, api, store: memoryActTokenStore(), now: NOW });

        const router = createCallbackRouter({
            d: decisionPressHandler({
                actDeps: async () => {
                    throw new Error("token store locked");
                },
                now: () => NOW + 1,
            }),
        });
        const [message] = api.messages;
        const reply = await router.route({
            id: "cbq-9",
            data: message.buttons[0][0].data,
            chatId: 7009,
            messageId: message.message,
        });

        expect(reply.toast).toBe("That did not work. Check the hub.");
        expect(await retractDecisionTelegramMessages(["d_9_s-nine"], { bot: own, api, now: NOW + 2 })).toBe(1);
        expect(api.messages[0].buttons).toEqual([]);
    });

    it("gives a pressed message back when the outcome edit fails, so the retraction still drops its buttons", async () => {
        class EditFailsOnce extends FakeTelegramMessagesApi {
            private failed = false;

            override async editMessageText(...args: Parameters<FakeTelegramMessagesApi["editMessageText"]>) {
                if (!this.failed) {
                    this.failed = true;
                    throw new Error("Bad Gateway");
                }

                return super.editMessageText(...args);
            }
        }
        const own = { ...bot, chats: { commands: 7010 } };
        const api = new EditFailsOnce();
        const store = memoryActTokenStore();
        const row = decision({ id: "d_10_s-ten", number: 10, sessionId: "s-ten" });
        await postDecisionsToTelegram([row], { bot: own, api, store, now: NOW });

        const actDeps: ActDeps = {
            store,
            rows: () => [row],
            answer: async () => ({ session: "s-ten", text: "10a", channel: "cmux", delivered: true, detail: "cmux" }),
        };
        const router = createCallbackRouter({
            d: decisionPressHandler({ actDeps: async () => actDeps, now: () => NOW + 1 }),
        });
        const [message] = api.messages;
        await answerPress({
            api,
            router,
            press: { id: "cbq-10", data: message.buttons[0][0].data, chatId: 7010, messageId: message.message },
        });

        expect(api.messages[0].buttons).not.toEqual([]);
        expect(await retractDecisionTelegramMessages(["d_10_s-ten"], { bot: own, api, now: NOW + 2 })).toBe(1);
        expect(api.messages[0].buttons).toEqual([]);
    });

    it("a later press on a message an earlier press answered keeps that outcome and only toasts the refusal", async () => {
        const own = { ...bot, chats: { commands: 7011 } };
        const api = new FakeTelegramMessagesApi();
        const store = memoryActTokenStore();
        const row = decision({ id: "d_11_s-eleven", number: 11, sessionId: "s-eleven" });
        await postDecisionsToTelegram([row], { bot: own, api, store, now: NOW });

        let answered = false;
        const actDeps: ActDeps = {
            store,
            rows: () => [answered ? { ...row, state: "sent" } : row],
            answer: async () => {
                answered = true;
                return { session: "s-eleven", text: "11a", channel: "cmux", delivered: true, detail: "cmux" };
            },
        };
        const router = createCallbackRouter({
            d: decisionPressHandler({ actDeps: async () => actDeps, now: () => NOW + 1 }),
        });
        const [message] = api.messages;
        // The first press's edit drops the buttons, so read the button data before it.
        const data = message.buttons[0][0].data;
        const press = (id: string) => ({ id, data, chatId: 7011, messageId: message.message });

        await answerPress({ api, router, press: press("cbq-11a") });
        const delivered = api.messages[0].text;
        const late = await answerPress({ api, router, press: press("cbq-11b") });

        expect(delivered).toContain("sent to the agent");
        expect(late.edit).toBeUndefined();
        expect(late.toast).toBe("Not sent");
        expect(api.messages[0].text).toBe(delivered);
    });

    it("edits the message of a decision closed elsewhere and drops its buttons", async () => {
        const api = new FakeTelegramMessagesApi();
        await postDecisionsToTelegram([decision({ id: "d_6_s-six", number: 6, sessionId: "s-six" })], {
            bot,
            api,
            store: memoryActTokenStore(),
            now: NOW,
        });

        expect(await retractDecisionTelegramMessages(["d_6_s-six"], { bot, api, now: NOW + 2 })).toBe(1);
        expect(api.messages[0].text.endsWith(CLOSED_ELSEWHERE)).toBe(true);
        expect(api.messages[0].buttons).toEqual([]);
        expect(await retractDecisionTelegramMessages(["d_6_s-six"], { bot, api, now: NOW + 2 })).toBe(0);
    });

    it("a decision that takes several letters: letters tick the staged pick, the keyboard shows it, and Send answers with it", async () => {
        const own = { ...bot, chats: { commands: 7012 } };
        const api = new FakeTelegramMessagesApi();
        const store = memoryActTokenStore();
        let row = decision({
            id: "d_12_s-twelve",
            number: 12,
            sessionId: "s-twelve",
            prompt: "Which caches?\n\na) memory\nb) disk\nc) network",
            options: ["memory", "disk", "network"],
            recommended: "ac",
            multiple: true,
        });
        await postDecisionsToTelegram([row], { bot: own, api, store, now: NOW });

        const staged: DraftInput[] = [];
        const calls: AnswerDecisionInput[] = [];
        const actDeps: ActDeps = {
            store,
            rows: () => [row],
            answer: async (input) => {
                calls.push(input);
                return { session: "s-twelve", text: "12ac", channel: "cmux", delivered: true, detail: "cmux" };
            },
            stage: async (input) => {
                staged.push(input);
                row = { ...row, state: input.option ? "drafted" : "open", draftOption: input.option ?? "" };
                return row;
            },
        };
        const router = createCallbackRouter({
            d: decisionPressHandler({ actDeps: async () => actDeps, now: () => NOW + 1 }),
        });
        const [message] = api.messages;
        const posted = message.text;
        const labels = () => message.buttons.map((buttons) => buttons.map((button) => button.text));
        const [a, , c] = message.buttons[0].map((button) => button.data);
        const tap = (id: string, data: string) =>
            answerPress({ api, router, press: { id, data, chatId: 7012, messageId: message.message } });

        expect(posted).toContain("Tick any set of letters, then press Send.");
        expect(labels()).toEqual([["a ★", "b", "c ★"]]);

        await tap("cbq-12a", a);
        expect(labels()).toEqual([["✓ a ★", "b", "c ★"], ["Send a"]]);
        expect(message.text).toBe(posted);

        await tap("cbq-12c", c);
        // Telegram's retry of the first press returns its receipt: a stays ticked.
        await tap("cbq-12a", a);
        expect(labels()).toEqual([["✓ a ★", "b", "✓ c ★"], ["Send a + c"]]);
        expect(staged.map((input) => input.option)).toEqual(["a", "ac"]);
        expect(staged[0]).toMatchObject({ session: "s-twelve", number: 12, expectedRevision: 1 });

        await tap("cbq-12a2", a);
        expect(labels()).toEqual([["a ★", "b", "✓ c ★"], ["Send c"]]);
        await tap("cbq-12a3", a);
        expect(api.answered.at(-1)).toEqual({ id: "cbq-12a3", text: "Ticked a + c" });
        expect(calls).toEqual([]);

        await tap("cbq-12send", message.buttons[1][0].data);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            session: "s-twelve",
            number: 12,
            option: "ac",
            deliveryKey: "telegram:cbq-12send",
        });
        expect(message.text).toContain("Which caches?");
        expect(message.text).toContain("→ a + c sent to the agent (cmux)");
        expect(message.buttons).toEqual([]);
    });

    it("a toggle on a decision that closed meanwhile refuses and drops the buttons", async () => {
        const own = { ...bot, chats: { commands: 7013 } };
        const api = new FakeTelegramMessagesApi();
        const store = memoryActTokenStore();
        const row = decision({ id: "d_13_s-thirteen", number: 13, sessionId: "s-thirteen", multiple: true });
        await postDecisionsToTelegram([row], { bot: own, api, store, now: NOW });

        const staged: DraftInput[] = [];
        const actDeps: ActDeps = {
            store,
            rows: () => [{ ...row, state: "sent" }],
            answer: async () => ({ session: "s-thirteen", text: "13a", channel: "cmux", delivered: true }),
            stage: async (input) => {
                staged.push(input);
                return row;
            },
        };
        const router = createCallbackRouter({
            d: decisionPressHandler({ actDeps: async () => actDeps, now: () => NOW + 1 }),
        });
        const [message] = api.messages;
        const reply = await answerPress({
            api,
            router,
            press: { id: "cbq-13", data: message.buttons[0][0].data, chatId: 7013, messageId: message.message },
        });

        expect(staged).toEqual([]);
        expect(reply.toast).toBe("Not sent");
        expect(message.text).toContain("Not sent: DECISION 13 is sent already.");
        expect(message.buttons).toEqual([]);
    });
});
