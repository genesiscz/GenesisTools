import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { openHubDb } from "./data-db";
import { recordNav } from "./navigation/store";
import { isNavActor, type NavEntry, normalizeTarget } from "./navigation/types";

const { log } = logger.scoped("hub:nav");

/** The flags of `tools hub nav record`, as the CLI and the resident server's door both read them. */
export interface NavRecordFlags {
    id: string;
    actor: string;
    title: string;
    target: string;
    at?: string;
    note?: string;
    from?: string;
    keep?: number;
    replacing?: string[];
}

/** The one log line per navigation, in the day log (`~/.genesis-tools/logs/<date>.log`). */
export function logNavigation(entry: NavEntry, via: string): void {
    // Debug: the day log keeps every level, and an agent's terminal does not need the block.
    log.debug(
        { via, actor: entry.actor, target: entry.target, note: entry.note, from: entry.from, id: entry.id },
        `hub nav: ${entry.actor} → ${entry.title}${entry.note ? ` (${entry.note})` : ""}`
    );
}

/** The entry `flags` describe, or null when `--actor` is not a known actor (the CLI prints that error). */
export function navEntryFromFlags(flags: NavRecordFlags): NavEntry | null {
    if (!isNavActor(flags.actor)) {
        return null;
    }

    const target = normalizeTarget(SafeJSON.parse(flags.target, { strict: true }));
    const at = flags.at === undefined ? Date.now() : Number(flags.at);
    const entry: NavEntry = {
        id: flags.id,
        at: Number.isFinite(at) ? at : Date.now(),
        actor: flags.actor,
        title: flags.title,
        target,
    };

    if (flags.note) {
        entry.note = flags.note;
    }

    if (flags.from) {
        entry.from = flags.from;
    }

    return entry;
}

/** Stores one entry the hub's engine made or changed, and logs it: `{ entry, kept, dropped }`. */
export function storeNavEntry(
    entry: NavEntry,
    options: { keep?: number; replacing?: string[] }
): { entry: NavEntry; kept: number; dropped: number } {
    const db = openHubDb();

    try {
        const result = recordNav(db, entry, options);
        logNavigation(entry, "hub");
        return { entry, ...result };
    } finally {
        db.close();
    }
}
