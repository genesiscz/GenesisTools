import { describe, expect, it } from "bun:test";
import type { ActDeps } from "@app/question/lib/act/act";
import { memoryActTokenStore } from "@app/question/lib/act/tokens";
import type { DecisionRecord } from "@app/question/lib/decisions/store";
import {
    CLOSED_ELSEWHERE,
    postDecisionsToTelegram,
    retractDecisionTelegramMessages,
} from "@app/question/lib/decisions/telegram";
import type { AnswerDecisionInput } from "@app/question/lib/inbox/answer";
import { FakeTelegramMessagesApi } from "@genesiscz/utils/telegram-bot/lib/fake-messages-api";
import type { TelegramBotConfig } from "@genesiscz/utils/telegram-bot/lib/types";
import { decisionPressHandler } from "./callback-routes";
import { answerPress, createCallbackRouter } from "./callbacks";

const CHAT = 7001;
const NOW = Date.parse("2026-11-03T10:00:00Z");

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
        await postDecisionsToTelegram([row], { bot, api, store, now: NOW });

        const calls: AnswerDecisionInput[] = [];
        const actDeps: ActDeps = {
            store,
            rows: () => [row],
            answer: async (input) => {
                calls.push(input);
                return { session: "s-five", text: "5b", channel: "cmux", delivered: true, detail: "cmux · work" };
            },
        };
        const router = createCallbackRouter({ d: decisionPressHandler({ actDeps: async () => actDeps }) });
        const [message] = api.messages;
        const press = { id: "cbq-1", data: message.buttons[0][1].data, chatId: CHAT, messageId: message.message };

        await answerPress({ api, router, press });
        const retry = await router.route(press);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ session: "s-five", number: 5, option: "b", deliveryKey: "telegram:cbq-1" });
        expect(api.answered).toEqual([{ id: "cbq-1", text: "Sent b" }]);
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

    it("edits the message of a decision closed elsewhere and drops its buttons", async () => {
        const api = new FakeTelegramMessagesApi();
        await postDecisionsToTelegram([decision({ id: "d_6_s-six", number: 6, sessionId: "s-six" })], {
            bot,
            api,
            store: memoryActTokenStore(),
            now: NOW,
        });

        expect(await retractDecisionTelegramMessages(["d_6_s-six"], { bot, api })).toBe(1);
        expect(api.messages[0].text.endsWith(CLOSED_ELSEWHERE)).toBe(true);
        expect(api.messages[0].buttons).toEqual([]);
        expect(await retractDecisionTelegramMessages(["d_6_s-six"], { bot, api })).toBe(0);
    });
});
