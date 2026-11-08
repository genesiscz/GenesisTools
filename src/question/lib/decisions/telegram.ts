import { logger } from "@genesiscz/utils/logger";
import { TELEGRAM_CLOSED_ELSEWHERE } from "@genesiscz/utils/notifications/channels/telegram";
import { createApi } from "@genesiscz/utils/telegram-bot/lib/api";
import { loadTelegramBotConfig, telegramChatFor } from "@genesiscz/utils/telegram-bot/lib/config";
import {
    postTelegramMessage,
    retractTelegramNotice,
    type TelegramButton,
    type TelegramMessagesApi,
} from "@genesiscz/utils/telegram-bot/lib/messages";
import type { TelegramBotConfig, TelegramDecisionProject } from "@genesiscz/utils/telegram-bot/lib/types";
import { decisionChoice } from "../act/act";
import {
    type ActTokenStore,
    issueActTokens,
    issueToggleTokens,
    type ToggleTokens,
    toggleTokensOf,
} from "../act/tokens";
import { NOTICE_IDS, type NoticeDeps, noticeItem, postNotice } from "../notices/notices";
import { needsHuman } from "./notify";
import { recommendedLetters, shownDecisionText } from "./option-labels";
import { awaitsAnswer, type DecisionRecord, decisionAskedIn, kindOf } from "./store";

const log = logger.child({ component: "question:decision-telegram" });

/** Telegram's message limit is 4096 characters; the prompt gets this much and the rest of the text fits around it. */
const PROMPT_MAX = 3000;
/** One option line's text at most, so a few long options cannot push the message over the limit. */
const OPTION_MAX = 300;
/** The whole message at most: leaves room for the outcome or retraction line an edit appends later. */
const TEXT_MAX = 3800;
/** Buttons per keyboard row: letters stay large enough to hit on a phone. */
const BUTTONS_PER_ROW = 4;
/** The callback router's prefix for a decision letter (`src/telegram-bot/lib/callback-routes.ts`). */
export const DECISION_CALLBACK_PREFIX = "d";

function clip(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * The message for one decision. With `text` on, the prompt and the options go to Telegram; with it off, only the
 * label, the project and the letters do (Telegram keeps what it is sent, so the text is a per-project opt-in).
 */
export function decisionTelegramText(row: DecisionRecord, project: TelegramDecisionProject): string {
    const head = `${kindOf(row) === "todo" ? "TODO" : "❓ DECISION"} ${row.number}${row.title ? `: ${row.title}` : ""}`;
    // A sub-agent's decision names its thread and its lead, so two sessions' DECISION 1 read apart (DECISION 46 b).
    const where = [row.project, decisionAskedIn(row) ?? row.sessionTitle].filter(Boolean).join(" · ");
    const recommended = row.recommended ? `Recommended: ${row.recommended}` : undefined;
    const { several } = decisionChoice(row);

    if (!project.text) {
        const how = several
            ? "Tick any set of letters here and press Send, or open the hub for the text."
            : "Pick a letter here, or open the hub for the text.";
        return clip([head, where, how, recommended].filter(Boolean).join("\n"), TEXT_MAX);
    }

    const shown = shownDecisionText({ prompt: row.prompt, options: row.options, type: kindOf(row) });
    const prompt = clip(shown.prompt, PROMPT_MAX);
    const options = shown.options.map(
        (option, index) => `${String.fromCharCode(97 + index)}) ${clip(option, OPTION_MAX)}`
    );

    const how = several ? ["", "Tick any set of letters, then press Send."] : [];

    return clip(
        [head, where, "", prompt, "", ...options, ...how, ...(recommended ? ["", recommended] : [])]
            .filter((line, index) => line !== undefined && (line !== "" || index > 1))
            .join("\n"),
        TEXT_MAX
    );
}

function inRows(buttons: TelegramButton[]): TelegramButton[][] {
    const rows: TelegramButton[][] = [];

    for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) {
        rows.push(buttons.slice(index, index + BUTTONS_PER_ROW));
    }

    return rows;
}

/** "a + c": the letters of a pick as a button and an outcome line name them. */
export function pickLabel(pick: string): string {
    return [...pick].join(" + ");
}

function keyboard(letters: { letter: string; token: string }[], recommended?: string): TelegramButton[][] {
    return inRows(
        letters.map(({ letter, token }) => ({
            text: letter === recommended?.trim().toLowerCase() ? `${letter} ★` : letter,
            data: `${DECISION_CALLBACK_PREFIX}:${token}`,
        }))
    );
}

/**
 * The keyboard of a decision that takes several letters: one toggle per letter ("✓ a" while it is staged, "★" on a
 * recommended one), and under them "Send a + c" with the staged letters. Nothing staged: no Send button, since it
 * would answer nothing.
 */
export function toggleKeyboard(tokens: ToggleTokens, staged: string, recommended?: string): TelegramButton[][] {
    const ticked = new Set(staged);
    const starred = recommendedLetters(recommended);
    const letters = inRows(
        tokens.letters.map(({ letter, token }) => ({
            text: `${ticked.has(letter) ? "✓ " : ""}${letter}${starred.has(letter) ? " ★" : ""}`,
            data: `${DECISION_CALLBACK_PREFIX}:${token}`,
        }))
    );
    const pick = tokens.letters.map(({ letter }) => letter).filter((letter) => ticked.has(letter));

    return pick.length > 0
        ? [
              ...letters,
              [{ text: `Send ${pickLabel(pick.join(""))}`, data: `${DECISION_CALLBACK_PREFIX}:${tokens.send}` }],
          ]
        : letters;
}

/**
 * The keyboard after a press on one of its toggles: the same buttons, ticked by the decision's staged pick now (`staged`
 * when the log has no row yet). Null when the keyboard's tokens are gone or the decision no longer waits.
 */
export async function redrawnToggleKeyboard({
    token,
    staged,
    store,
    rows,
}: {
    token: string;
    staged: string;
    store: ActTokenStore;
    rows: () => DecisionRecord[];
}): Promise<TelegramButton[][] | null> {
    const tokens = await store.read();
    const group = tokens[token]?.group;
    const buttons = group ? toggleTokensOf(tokens, group) : null;

    if (!buttons) {
        return null;
    }

    const row = rows().find((entry) => entry.id === tokens[token]?.decisionId);

    if (row && !awaitsAnswer(row)) {
        return null;
    }

    return toggleKeyboard(buttons, row ? (row.draftOption ?? "") : staged, row?.recommended);
}

/** The buttons of one posted decision: a letter each, or the toggles and Send of a decision that takes several. */
async function decisionKeyboard(row: DecisionRecord, deps: DecisionTelegramDeps): Promise<TelegramButton[][]> {
    const common = {
        row,
        surface: "telegram" as const,
        ...(deps.store ? { store: deps.store } : {}),
        ...(deps.now === undefined ? {} : { now: deps.now }),
    };

    const choice = decisionChoice(row);

    if (!choice.several) {
        return keyboard(await issueActTokens(common), row.recommended);
    }

    const tokens = await issueToggleTokens({ ...common, count: choice.count });
    return toggleKeyboard(tokens, row.draftOption ?? "", row.recommended);
}

export interface DecisionTelegramDeps {
    notices?: NoticeDeps;
    bot?: TelegramBotConfig | null;
    api?: TelegramMessagesApi;
    store?: ActTokenStore;
    now?: number;
}

/**
 * Posts each decision that waits for the human to Telegram, one message with one button per option letter (a toggle
 * per letter and a Send button for a decision that takes several), when its project opted in (`tools telegram-bot decisions enable <project>`). The message is remembered by the banner's id,
 * so the write that closes the decision edits it. Never throws: the rows are stored, and a post that cannot go out
 * must not fail it. Returns how many messages went out.
 */
export async function postDecisionsToTelegram(
    rows: DecisionRecord[],
    deps: DecisionTelegramDeps = {}
): Promise<number> {
    try {
        const bot = deps.bot === undefined ? await loadTelegramBotConfig() : deps.bot;
        const projects = bot?.decisions?.projects ?? {};
        // Decisions only: the act door answers by session and number among decisions, and a to-do item keeps its own
        // numbering, so a button on to-do item 1 would answer DECISION 1 of the same session.
        const waiting = rows.filter(
            (row) =>
                kindOf(row) === "decision" &&
                needsHuman(row) &&
                row.options.length > 0 &&
                row.project &&
                Object.hasOwn(projects, row.project)
        );

        if (!bot || waiting.length === 0) {
            return 0;
        }

        const api = deps.api ?? createApi(bot.botToken, bot.apiRoot);
        const chatId = telegramChatFor(bot, "decisions");
        let posted = 0;

        for (const row of waiting) {
            // One row that Telegram refuses must not stop the rows after it.
            try {
                const project = projects[row.project as string];
                const buttons = await decisionKeyboard(row, deps);
                const delivered = await postNotice(
                    {
                        event: {
                            app: "question",
                            id: NOTICE_IDS.decision(row.id),
                            only: ["telegram"],
                            message: decisionTelegramText(row, project),
                        },
                        items: [noticeItem("decision", row.id)],
                        send: async () => {
                            await postTelegramMessage({
                                api,
                                chatId,
                                text: decisionTelegramText(row, project),
                                buttons,
                                noticeId: NOTICE_IDS.decision(row.id),
                                ...(deps.now === undefined ? {} : { now: deps.now }),
                            });
                            return true;
                        },
                    },
                    deps.notices
                );
                if (delivered) {
                    posted++;
                }
            } catch (err) {
                log.warn({ err, id: row.id }, "could not post a decision to Telegram; it is stored");
            }
        }

        log.info({ ids: waiting.map((row) => row.id), posted }, "decisions posted to Telegram");
        return posted;
    } catch (err) {
        log.warn({ err }, "could not post decisions to Telegram; they are stored");
        return 0;
    }
}

/** The line a closed decision's message gets; the same one the channel table's Telegram retraction writes. */
export const CLOSED_ELSEWHERE = TELEGRAM_CLOSED_ELSEWHERE;

/** Edits the Telegram messages of decisions that stopped waiting: the buttons go, and one line says why. */
export async function retractDecisionTelegramMessages(
    ids: readonly string[],
    deps: { bot?: TelegramBotConfig | null; api?: TelegramMessagesApi; now?: number } = {}
): Promise<number> {
    const bot = deps.bot === undefined ? await loadTelegramBotConfig() : deps.bot;

    if (!bot) {
        return 0;
    }

    const api = deps.api ?? createApi(bot.botToken, bot.apiRoot);
    let edited = 0;

    for (const id of ids) {
        const done = await retractTelegramNotice({
            api,
            noticeId: NOTICE_IDS.decision(id),
            edit: (original) => `${original ?? id}\n\n${CLOSED_ELSEWHERE}`,
            ...(deps.now === undefined ? {} : { now: deps.now }),
        });
        edited += done ? 1 : 0;
    }

    return edited;
}
