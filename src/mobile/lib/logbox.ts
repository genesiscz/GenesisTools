import { logger } from "@genesiscz/utils/logger";
import { center, type LogBoxView, parseSource, readLogBox } from "@genesiscz/utils/mobile/a11y";
import type { AppiumSession } from "@genesiscz/utils/mobile/webdriver";

const log = logger.child({ component: "mobile.logbox" });

export interface LogBoxEntry {
    index: number;
    total: number;
    heading?: string;
    message: string[];
}

export const LOGBOX_CLEAR_MODES = ["minimize", "dismiss"] as const;
export type LogBoxClearMode = (typeof LOGBOX_CLEAR_MODES)[number];

/** Taps settle with an animation; reading the tree sooner sees the old frame. */
const SETTLE_MS = 700;
const GUARD = 40;

async function view(session: AppiumSession): Promise<LogBoxView> {
    return readLogBox(parseSource(await session.source()));
}

/**
 * Reads every entry of React Native's LogBox (a Debug build only) and leaves it minimized, or dismissed with
 * `clear: "dismiss"`. The header's back and forward arrows have no accessibility name, so they are tapped by position
 * on the counter's row. Minimize is the safe way to get it out of a run's way: dismissing removes one entry and shows
 * the next, so a screen with many entries would take a tap per entry.
 */
export async function readLogBoxEntries(
    session: AppiumSession,
    options: { clear: LogBoxClearMode }
): Promise<{ entries: LogBoxEntry[]; before: LogBoxView["state"] }> {
    let current = await view(session);
    const before = current.state;

    if (current.state === "none") {
        return { entries: [], before };
    }

    if (current.state === "collapsed" && current.toast) {
        const point = center(current.toast.rect);
        await session.tapAt(point.x, point.y);
        await Bun.sleep(SETTLE_MS);
        current = await view(session);
    }

    if (current.state !== "expanded" || current.headerY === undefined) {
        log.warn({ state: current.state }, "the LogBox toast did not open");
        return { entries: [], before };
    }

    const { width } = await session.windowSize();
    const arrow = async (side: "back" | "forward") => {
        await session.tapAt(side === "back" ? 24 : width - 24, current.headerY ?? 0);
        await Bun.sleep(SETTLE_MS);
        current = await view(session);
    };

    for (let guard = 0; guard < GUARD && (current.index ?? 1) > 1; guard++) {
        const previous = current.index;
        await arrow("back");

        if (current.index === previous) {
            log.warn("LogBox back arrow made no progress");
            break;
        }
    }

    const entries: LogBoxEntry[] = [];
    for (let guard = 0; guard < GUARD && current.state === "expanded"; guard++) {
        entries.push({
            index: current.index ?? 0,
            total: current.total ?? 0,
            heading: current.heading,
            message: current.message,
        });

        if ((current.index ?? 0) >= (current.total ?? 0)) {
            break;
        }

        const previous = current.index;
        await arrow("forward");

        if (current.index === previous) {
            log.warn("LogBox forward arrow made no progress");
            break;
        }
    }

    if (options.clear === "dismiss") {
        for (let guard = 0; guard < GUARD && current.state === "expanded" && current.dismiss; guard++) {
            const point = center(current.dismiss.rect);
            await session.tapAt(point.x, point.y);
            await Bun.sleep(SETTLE_MS);
            current = await view(session);
        }
    } else if (current.minimize) {
        const point = center(current.minimize.rect);
        await session.tapAt(point.x, point.y);
        await Bun.sleep(SETTLE_MS);
    }

    log.info({ entries: entries.length, clear: options.clear }, "logbox read");
    return { entries, before };
}
