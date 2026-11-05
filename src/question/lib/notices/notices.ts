import { logger } from "@genesiscz/utils/logger";
import {
    CHANNEL_NAMES,
    CHANNELS,
    type ChannelName,
    dispatchNotification,
    type NotificationEvent,
    notificationsConfig,
} from "@genesiscz/utils/notifications";
import { recordNotification } from "@genesiscz/utils/notifications/ledger";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { fileNoticeStore, NOTICE_TTL_MS, type NoticeMap, type NoticeRecord, type NoticeStore } from "./store";

const log = logger.child({ component: "question:notices" });

/** What a notice can be about: a waiting item of the waiting set. */
export type NoticeItemKind = "decision" | "form" | "dialog";

/** The key of one waiting item inside a notice record. */
export function noticeItem(kind: NoticeItemKind, id: string): string {
    return `${kind}:${id}`;
}

/**
 * The one id scheme of every notice. A notice about one item is named by it; the grouped banner of a post is named by
 * its first decision and lists every decision of the post. `isSafeNotificationId` accepts all of them.
 */
export const NOTICE_IDS = {
    /** One decision: the phone push and the Telegram message. */
    decision: (id: string) => `qa-decision-${id}`,
    /** The grouped Mac banner of one post of decisions. */
    post: (firstId: string) => `qa-post-${firstId}`,
    /** The stale reminder of one decision. */
    stale: (id: string) => `qa-stale-${id}`,
    form: (id: string) => `qa-form-${id}`,
    dialog: (key: string) => `qa-dialog-${key}`,
} as const;

export interface NoticeDeps {
    store: NoticeStore;
    dispatch: (event: NotificationEvent) => Promise<boolean>;
    /** Takes one notice back on one channel; true when something was taken back. */
    retract: (channel: ChannelName, noticeId: string) => Promise<boolean>;
    now: () => number;
}

async function realRetract(channel: ChannelName, noticeId: string): Promise<boolean> {
    const prefix = NOTICE_IDS.decision("");
    if (channel === "telegram" && noticeId.startsWith(prefix)) {
        const { retractDecisionTelegramMessages } = await import("../decisions/telegram");
        return (await retractDecisionTelegramMessages([noticeId.slice(prefix.length)])) > 0;
    }
    const channels = await notificationsConfig.getChannels("question");
    return retractOn(channel, noticeId, channels);
}

function retractOn<K extends ChannelName>(
    channel: K,
    noticeId: string,
    channels: Awaited<ReturnType<typeof notificationsConfig.getChannels>>
): Promise<boolean> {
    return CHANNELS[channel].retract(noticeId, channels[channel]);
}

let override: NoticeDeps | undefined;

/** A test passes fakes here; a test process otherwise posts and retracts nothing. */
export function setNoticeDeps(deps: NoticeDeps | undefined): void {
    override = deps;
}

function currentDeps(): NoticeDeps | undefined {
    if (override) {
        return override;
    }

    if (isTestProcess()) {
        return undefined;
    }

    return { store: fileNoticeStore(), dispatch: dispatchNotification, retract: realRetract, now: Date.now };
}

function pruned(notices: NoticeMap, now: number): void {
    for (const [id, record] of Object.entries(notices)) {
        if (now - record.postedAt >= NOTICE_TTL_MS) {
            delete notices[id];
        }
    }
}

/** Remembers a notice that went out another way (the Telegram decision message), so its close retracts it. */
export async function recordNotice(
    notice: Omit<NoticeRecord, "postedAt">,
    deps: NoticeDeps | undefined = currentDeps()
): Promise<void> {
    if (!deps || notice.items.length === 0) {
        return;
    }

    const now = deps.now();
    await deps.store.update((notices) => {
        pruned(notices, now);
        const previous = notices[notice.id];
        notices[notice.id] = {
            ...notice,
            channels: [...new Set([...(previous?.channels ?? []), ...notice.channels])],
            items: [...new Set([...(previous?.items ?? []), ...notice.items])],
            postedAt: now,
        };
    });
}

/**
 * Posts one notice through the channel table and remembers which items it is about, so the write that closes the last
 * of them retracts it on every channel it went to. `event.id` is the notice id. Never throws; true when every channel
 * accepted it.
 */
export async function postNotice(
    {
        event,
        items,
        send,
    }: { event: NotificationEvent & { id: string }; items: string[]; send?: () => Promise<boolean> },
    deps: NoticeDeps | undefined = currentDeps()
): Promise<boolean> {
    if (!deps) {
        return false;
    }

    try {
        const channels = event.only ?? [...CHANNEL_NAMES];
        await recordNotice({ id: event.id, channels, items }, deps);
        const delivered = await (send ? send() : deps.dispatch(event));
        const closed = await deps.store.update((notices) => !notices[event.id]);
        if (closed) {
            await Promise.all(channels.map((channel) => deps.retract(channel, event.id)));
        }

        return delivered;
    } catch (err) {
        log.warn({ err, id: event.id }, "could not post a notice; the items it is about are stored");
        return false;
    }
}

/**
 * The items stopped waiting (answered, dismissed, cancelled, closed): each notice keeps the items still open, and a
 * notice left with none is retracted on every channel it went to. Returns the retracted notice ids. Never throws.
 */
export async function closeNoticeItems(
    items: readonly string[],
    deps: NoticeDeps | undefined = currentDeps()
): Promise<string[]> {
    if (!deps || items.length === 0) {
        return [];
    }

    try {
        const closing = new Set(items);
        const emptied = await deps.store.update((notices) => {
            const done: NoticeRecord[] = [];

            for (const [id, record] of Object.entries(notices)) {
                if (!record.items.some((item) => closing.has(item))) {
                    continue;
                }

                const left = record.items.filter((item) => !closing.has(item));

                if (left.length > 0) {
                    notices[id] = { ...record, items: left };
                    continue;
                }

                done.push(record);
                delete notices[id];
            }

            return done;
        });

        await Promise.all(
            emptied.flatMap((record) =>
                record.channels.map(async (channel) => {
                    const taken = await deps.retract(channel, record.id).catch((err: unknown) => {
                        log.debug({ err, channel, id: record.id }, "could not retract a notice");
                        return false;
                    });

                    if (taken) {
                        await recordNotification({ source: "question", channel, outcome: "withdrawn", id: record.id });
                    }
                })
            )
        );

        if (emptied.length > 0) {
            log.debug({ ids: emptied.map((record) => record.id) }, "notices retracted");
        }

        return emptied.map((record) => record.id);
    } catch (err) {
        log.warn({ err, items }, "could not retract notices");
        return [];
    }
}

/** Best effort and never awaited by a write, like the banner retraction it replaces. */
export function closeNoticeItemsLater(items: readonly string[]): void {
    void closeNoticeItems(items);
}
