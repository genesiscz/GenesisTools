import { withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { NotificationAction } from "@genesiscz/utils/macos/notifications";
import { CHANNEL_NAMES, notificationsConfig } from "@genesiscz/utils/notifications";
import { MAX_ANSWER_LETTERS, REPLY_TOKEN_KEY } from "@genesiscz/utils/notifications/phone-wire";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { clipOneLine } from "@genesiscz/utils/string";
import { decisionChoice } from "../act/act";
import { type ActTokenStore, issueActTokens, issueAnswerToken, issueReplyToken } from "../act/tokens";
import { hubItemClickCommand } from "../hub-link";
import { NOTICE_IDS, type NoticeDeps, noticeItem, postNotice } from "../notices/notices";
import { waitsOnHuman } from "../waiting/set";
import { recommendedLetters, shownDecisionText } from "./option-labels";
import { type DecisionRecord, decisionAskedIn, kindOf } from "./store";

const log = logger.child({ component: "question:decision-notify" });

const MESSAGE_MAX = 220;
/** The lock screen shows about four lines; the rest is a tap away. */
const PROMPT_MAX = 400;
const OPTION_MAX = 120;

/**
 * Whether a posted row raises a banner: it is open (a stage never re-raises one) and the waiting set says it
 * waits for the human (`waitsOnHuman`: the `for` rule, no uncertain delivery).
 */
export function needsHuman(row: DecisionRecord): boolean {
    return row.state === "open" && waitsOnHuman(row);
}

export function decisionLabel(row: DecisionRecord): string {
    const head = `${kindOf(row) === "todo" ? "TODO" : "❓ DECISION"} ${row.number}`;
    return row.title ? `${head}: ${row.title}` : head;
}

/**
 * Whether one-tap answers fit the row: a decision (the act door answers decisions by number, and a to-do item keeps
 * its own numbering) with one to `MAX_ANSWER_LETTERS` options.
 */
export function answerable(row: DecisionRecord): boolean {
    return kindOf(row) === "decision" && row.options.length > 0 && row.options.length <= MAX_ANSWER_LETTERS;
}

/** The prompt, the lettered options and the recommendation, short enough for a lock screen. */
export function phoneDecisionBody(row: DecisionRecord): string {
    const shown = shownDecisionText({ prompt: row.prompt, options: row.options, type: kindOf(row) });
    const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
    const options = shown.options.map(
        (option, index) => `${String.fromCharCode(97 + index)}) ${clip(option, OPTION_MAX)}`
    );
    return [clip(shown.prompt, PROMPT_MAX), ...options, ...(row.recommended ? [`Recommended: ${row.recommended}`] : [])]
        .filter(Boolean)
        .join("\n");
}

function letterTitle(letter: string, recommended?: string): string {
    return letter === recommended?.trim().toLowerCase() ? `${letter} ★` : letter;
}

/**
 * The recommended letters of a decision that takes several, when every one of them is an option it shows ("abc"), else
 * undefined. One banner button answers with that set.
 */
export function recommendedSet(row: DecisionRecord): string | undefined {
    const letters = [...recommendedLetters(row.recommended)];
    const { count } = decisionChoice(row);
    const fits = letters.length > 0 && letters.every((letter) => letter.charCodeAt(0) - 97 < count);
    return fits ? letters.join("") : undefined;
}

export interface DecisionNoticeDeps {
    notices?: NoticeDeps;
    tokens?: ActTokenStore;
    /** The GenesisTools.app bundle; tests pass a fixture path. */
    bundle?: string;
    /** Whether the phone channel is on for decisions; read from the notify config when omitted. */
    phoneEnabled?: boolean;
}

/**
 * The grouped Mac banner of a post: its click and "Open in hub" open the hub's Inbox at the first decision, and a post
 * of one answerable decision gets one button per letter that answers through the act door (`tools question act`). A
 * decision that takes several letters gets no letter buttons (one would answer one letter), only "Send a + b ★" with
 * its recommended set when it names one. It goes to every channel but the phone, only when GenesisTools.app is
 * installed.
 */
async function postGroupedBanner(waiting: DecisionRecord[], deps: DecisionNoticeDeps): Promise<boolean> {
    const [first] = waiting;
    const click = hubItemClickCommand("decision", first.id, deps.bundle);

    if (!click) {
        log.debug({ id: first.id }, "GenesisTools.app is not installed; no decision banner");
        return false;
    }

    const id = NOTICE_IDS.post(first.id);
    const letters: NotificationAction[] = [];
    const several = decisionChoice(first).several;
    const set = several ? recommendedSet(first) : undefined;

    // One button, so the bound on the number of letter buttons (`answerable`) does not apply to it.
    if (waiting.length === 1 && kindOf(first) === "decision" && set) {
        const token = await issueAnswerToken({
            row: first,
            option: set,
            surface: "banner",
            ...(deps.tokens ? { store: deps.tokens } : {}),
        });
        letters.push({
            id: `answer-${set}`,
            title: `Send ${[...set].join(" + ")} ★`,
            execute: shellCommandLine(["tools", "question", "act", token, "--key", `banner:${id}:${set}`]),
        });
    }

    if (waiting.length === 1 && answerable(first) && !several) {
        const issued = await issueActTokens({
            row: first,
            surface: "banner",
            ...(deps.tokens ? { store: deps.tokens } : {}),
        });

        for (const { letter, token } of issued) {
            letters.push({
                id: `answer-${letter}`,
                title: letterTitle(letter, first.recommended),
                // Notify.swift runs this with /bin/sh -c; the token is base64url and the key is built here.
                execute: shellCommandLine(["tools", "question", "act", token, "--key", `banner:${id}:${letter}`]),
            });
        }
    }

    // A sub-agent's decision names its thread and its lead, so two sessions' DECISION 1 read apart (DECISION 46 b).
    const where = decisionAskedIn(first) ?? first.project ?? first.sessionTitle;
    return postNotice(
        {
            event: {
                app: "question",
                title: waiting.length === 1 ? decisionLabel(first) : `${waiting.length} decisions wait for you`,
                subtitle: waiting.length === 1 ? where : `${decisionLabel(first)}${where ? ` · ${where}` : ""}`,
                message: clipOneLine(first.prompt, MESSAGE_MAX),
                id,
                execute: click,
                actions: [{ id: "open-hub", title: "Open in hub", execute: click }, ...letters],
                only: CHANNEL_NAMES.filter((name) => name !== "phone"),
            },
            items: waiting.map((row) => noticeItem("decision", row.id)),
        },
        deps.notices
    );
}

/**
 * One push per waiting row, so each carries its own letter buttons on the lock screen. The answer tokens are issued
 * for the phone surface and sealed to each device by the phone channel. A decision that takes several letters goes
 * without buttons and without a Reply field: a lock-screen button answers one letter, and every category the phone app
 * registers carries letter buttons (`answerCategories`), so a Reply-only one needs a new app build.
 */
async function postPhonePushes(waiting: DecisionRecord[], deps: DecisionNoticeDeps): Promise<number> {
    let posted = 0;

    for (const row of waiting) {
        const issued =
            answerable(row) && !decisionChoice(row).several
                ? await issueActTokens({ row, surface: "phone", ...(deps.tokens ? { store: deps.tokens } : {}) })
                : [];
        const sent = await postNotice(
            {
                event: {
                    app: "question",
                    title: decisionLabel(row),
                    ...(decisionAskedIn(row) || row.project || row.sessionTitle
                        ? { subtitle: decisionAskedIn(row) ?? row.project ?? row.sessionTitle }
                        : {}),
                    message: phoneDecisionBody(row),
                    id: NOTICE_IDS.decision(row.id),
                    timeSensitive: row.blocking !== false,
                    phone: {
                        thread: row.sessionId,
                        ...(issued.length > 0
                            ? {
                                  answers: {
                                      letters: issued.map(({ letter }) => letter),
                                      ...(row.recommended ? { recommended: row.recommended.trim().toLowerCase() } : {}),
                                      tokens: {
                                          ...Object.fromEntries(issued.map(({ letter, token }) => [letter, token])),
                                          [REPLY_TOKEN_KEY]: await issueReplyToken({
                                              row,
                                              surface: "phone",
                                              ...(deps.tokens ? { store: deps.tokens } : {}),
                                          }),
                                      },
                                  },
                              }
                            : {}),
                    },
                    only: ["phone"],
                },
                items: [noticeItem("decision", row.id)],
            },
            deps.notices
        );
        posted += sent ? 1 : 0;
    }

    return posted;
}

async function phoneOn(deps: DecisionNoticeDeps): Promise<boolean> {
    if (deps.phoneEnabled !== undefined) {
        return deps.phoneEnabled;
    }

    return (await notificationsConfig.getChannels("question")).phone.enabled;
}

/**
 * The notices of a post of decisions: the grouped Mac banner (and the other channels but the phone), then one push per
 * decision to the phone. Each is remembered with the decisions it is about, so the write that closes the last of them
 * retracts it everywhere (`closeNoticeItems`). Never throws: the rows are stored, and a notice that cannot go out must
 * not fail the post.
 */
export async function postDecisionNotices(rows: DecisionRecord[], deps: DecisionNoticeDeps = {}): Promise<boolean> {
    const waiting = rows.filter(needsHuman);

    if (waiting.length === 0) {
        log.debug({ rows: rows.length }, "no posted decision waits for the human; no notice");
        return false;
    }

    try {
        const [banner, pushed] = await Promise.all([
            withTimeout(postGroupedBanner(waiting, deps), 10_000).catch((err: unknown) => {
                log.warn({ err }, "decision banner delivery failed or exceeded its deadline");
                return false;
            }),
            phoneOn(deps).then((enabled) => (enabled ? postPhonePushes(waiting, deps) : 0)),
        ]);
        log.info({ ids: waiting.map((row) => row.id), banner, pushed }, "decision notices sent");
        return banner || pushed > 0;
    } catch (err) {
        log.warn(
            { err, ids: waiting.map((row) => row.id) },
            "could not notify about posted decisions; they are stored"
        );
        return false;
    }
}
