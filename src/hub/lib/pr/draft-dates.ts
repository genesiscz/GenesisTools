import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * GitLab does not date draft notes. The first read that sees a draft records the time, and every
 * later read reuses it, so a refresh never turns an hour-old draft into "just now" (and the review
 * window never sees a changed answer when nothing changed).
 */

const log = logger.child({ component: "hub/pr/draft-dates" });

/** Per MR (its web URL), per draft id, the ISO time the draft was first seen. */
export type DraftDates = Record<string, Record<string, string>>;

export function draftDatesPath(): string {
    return toolDataDir("hub", "gitlab-draft-dates.json");
}

/**
 * The dates for this MR's current drafts: a known draft keeps its date, a new one gets `now`, and a
 * draft that is gone (published or deleted) is dropped.
 */
export function stampDraftDates({
    dates,
    mr,
    draftIds,
    now,
}: {
    dates: DraftDates;
    mr: string;
    draftIds: string[];
    now: Date;
}): { dates: DraftDates; byId: Map<string, string>; changed: boolean } {
    const known = dates[mr] ?? {};
    const next: Record<string, string> = {};
    let changed = false;

    for (const id of draftIds) {
        const seen = known[id];
        next[id] = seen ?? now.toISOString();

        if (!seen) {
            changed = true;
        }
    }

    if (Object.keys(known).some((id) => !(id in next))) {
        changed = true;
    }

    const all = { ...dates };

    if (draftIds.length === 0) {
        delete all[mr];
    } else {
        all[mr] = next;
    }

    return { dates: all, byId: new Map(Object.entries(next)), changed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps only `{ mr: { id: string } }` entries; anything else in the file is ignored. */
function asDraftDates(value: unknown): DraftDates {
    const dates: DraftDates = {};

    if (!isRecord(value)) {
        return dates;
    }

    for (const [mr, ids] of Object.entries(value)) {
        if (!isRecord(ids)) {
            continue;
        }

        const kept: Record<string, string> = {};

        for (const [id, at] of Object.entries(ids)) {
            if (typeof at === "string") {
                kept[id] = at;
            }
        }

        dates[mr] = kept;
    }

    return dates;
}

async function readDates(file: string): Promise<DraftDates> {
    const handle = Bun.file(file);

    if (!(await handle.exists())) {
        return {};
    }

    try {
        return asDraftDates(SafeJSON.parse(await handle.text()));
    } catch (err) {
        log.warn({ err, file }, "draft dates unreadable; every draft is dated now");
        return {};
    }
}

/** Reads, stamps and (when something changed) writes back the draft dates of one MR. */
export async function draftDatesFor({
    mr,
    draftIds,
    now = new Date(),
    file = draftDatesPath(),
}: {
    mr: string;
    draftIds: string[];
    now?: Date;
    file?: string;
}): Promise<Map<string, string>> {
    const stamped = stampDraftDates({ dates: await readDates(file), mr, draftIds, now });

    if (stamped.changed) {
        try {
            await mkdir(dirname(file), { recursive: true });
            await Bun.write(file, SafeJSON.stringify(stamped.dates, null, 2));
        } catch (err) {
            log.warn({ err, file }, "draft dates not saved; the next read dates new drafts again");
        }
    }

    return stamped.byId;
}
