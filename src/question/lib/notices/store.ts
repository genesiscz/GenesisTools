import type { ChannelName } from "@genesiscz/utils/notifications";
import { Storage } from "@genesiscz/utils/storage/storage";

/**
 * One posted notice: the channels it went to and the waiting items it is about. A notice stays while one of its items
 * still waits, and is retracted on every channel when the last one closes.
 */
export interface NoticeRecord {
    id: string;
    channels: ChannelName[];
    /** Item keys (`decision:<id>`, `form:<id>`, `dialog:<key>`), see `noticeItem`. */
    items: string[];
    postedAt: number;
}

export type NoticeMap = Record<string, NoticeRecord>;

/** A notice older than this is forgotten on the next write; its banner or push has long gone by then. */
export const NOTICE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface NoticeStore {
    update<T>(fn: (notices: NoticeMap) => T): Promise<T>;
}

const NOTICES_FILE = "notices.json";

/** `~/.genesis-tools/question/cache/notices.json`: a notice is posted in one process and retracted in another. */
export function fileNoticeStore(storage = new Storage("question")): NoticeStore {
    return {
        async update(fn) {
            let result: ReturnType<typeof fn> | undefined;
            await storage.atomicUpdate<NoticeMap>(NOTICES_FILE, (current) => {
                const notices = { ...(current ?? {}) };
                result = fn(notices);
                return notices;
            });
            return result as ReturnType<typeof fn>;
        },
    };
}

export function memoryNoticeStore(initial: NoticeMap = {}): NoticeStore & { notices: NoticeMap } {
    const notices = initial;
    return {
        notices,
        async update(fn) {
            return fn(notices);
        },
    };
}
