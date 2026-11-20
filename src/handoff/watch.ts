import type { Database } from "bun:sqlite";
import { logger } from "@genesiscz/utils/logger";
import type { Change } from "@genesiscz/utils/work/model/change";
import { journalHead, selectChangesAfter } from "@genesiscz/utils/work/store/rows";
import { catchUpHandoffs, handoffPayloadsByUid, listHandoffRows, openHandoffModel } from "./read-model";
import type { HandoffEvent } from "./types";

const log = logger.child({ component: "handoff:watch" });
/** How often a following watch reads the change feed; a new event shows within this. */
const FOLLOW_POLL_MS = 1_000;
const FEED_BATCH = 500;

/** A handoff event as the work store keeps it: the poster's edit credential is stripped at insert. */
export type WatchedHandoffEvent = HandoffEvent extends infer E
    ? E extends unknown
        ? Omit<E, "editId">
        : never
    : never;

/** `30m`, `6h`, `2d`, `90s`; `0` or empty means "no replay". Anything else throws. */
export function parseSince(value: string | undefined, now = Date.now()): number {
    const text = value?.trim() ?? "";

    if (text === "" || text === "0") {
        return 0;
    }

    const match = /^(\d+)\s*([smhd])$/.exec(text);

    if (!match) {
        throw new Error(`--since "${text}" is not a duration; use a number with s, m, h or d (90s, 30m, 6h, 2d), or 0`);
    }

    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
    const ms = Number(match[1]) * unit;

    if (!Number.isFinite(new Date(now - ms).getTime())) {
        throw new Error(`--since "${text}" reaches before the earliest date JavaScript can represent`);
    }

    return ms;
}

/** The uid of the handoff event behind a change, when the change came from one. */
function legacyUid(change: Change): string | null {
    return change.origin.via === "legacy" ? change.origin.uid : null;
}

/** The first journal position whose change is at or after `cutoffIso`, minus one (a cursor for `selectChangesAfter`). */
function cursorBefore(db: Database, cutoffIso: string): number {
    const row = db
        .query<{ seq: number | null }, [string]>("SELECT MIN(seq) AS seq FROM changes WHERE ts >= ?")
        .get(cutoffIso);
    return row?.seq === null || row?.seq === undefined ? journalHead(db) : row.seq - 1;
}

/**
 * The handoff events behind the work store's changes after `cursor`, in journal order, and the new cursor. A refused
 * attempt changes nothing, so it has no change and is not listed. `minTs` drops the older changes of a backfill.
 */
export function handoffEventsFromFeed(
    db: Database,
    cursor: number,
    minTs?: string
): { events: WatchedHandoffEvent[]; cursor: number } {
    const uids: string[] = [];
    const wanted = new Set<string>();
    let next = cursor;

    for (;;) {
        const changes = selectChangesAfter(db, next, FEED_BATCH);

        for (const change of changes) {
            const uid = legacyUid(change);

            if (uid !== null && !wanted.has(uid) && (minTs === undefined || change.ts >= minTs)) {
                wanted.add(uid);
                uids.push(uid);
            }
        }

        const last = changes.at(-1);

        if (last === undefined) {
            break;
        }

        next = last.seq;

        if (changes.length < FEED_BATCH) {
            break;
        }
    }

    const payloads = handoffPayloadsByUid(db, uids);
    const events = uids.flatMap((uid) => {
        const payload = payloads.get(uid);
        return payload === undefined ? [] : [payload as WatchedHandoffEvent];
    });
    return { events, cursor: next };
}

function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describe(event: WatchedHandoffEvent): string {
    switch (event.ev) {
        case "post":
            return `"${event.title}" (${event.tasks.length} tasks)`;
        case "claim":
            return `via ${event.via}`;
        case "check_task": {
            const commits = event.proof.commitIds?.length ? ` [${event.proof.commitIds.join(", ")}]` : "";
            return `${event.taskId}: ${oneLine(event.proof.answer, 180)}${commits}`;
        }
        case "deny_task":
            return `${event.taskId}: ${oneLine(event.reason, 180)}`;
        case "uncheck_task":
        case "undeny_task":
        case "modify_task":
            return event.taskId;
        case "comment":
            return oneLine(event.text, 220);
        case "add_tasks":
            return `${event.tasks.length} task(s)`;
        case "modify_handoff":
            // The raw log can contain a stale source project; the folded history has the authoritative source.
            return event.project !== undefined ? `project → ${event.project}` : "";
        default:
            return "";
    }
}

export function formatHandoffEvent(event: WatchedHandoffEvent, names: Map<string, string>): string {
    const time = new Date(event.ts).toLocaleTimeString("en-GB", { hour12: false });
    const who = `${event.by.agent}${event.by.sessionId ? `:${event.by.sessionId.slice(0, 8)}` : ""}`;
    const name = names.get(event.id);
    const detail = describe(event);
    return `${time} ${event.id}${name ? ` (${name})` : ""} ${event.ev}${detail ? ` — ${detail}` : ""} · by ${who}`;
}

export interface HandoffWatch {
    names: Map<string, string>;
    close(): void;
}

/**
 * Replay `sinceMs` of history, then follow the work store's change feed (`changes`, by journal position) and print the
 * handoff event behind each change. `filters` are handoff ids (with or without `h_`) or readable names; empty follows
 * every handoff. Events are de-duplicated by uid. Each read first folds what an older producer appended only to the
 * old day file, as every handoff reader does (`withHandoffReadDb`), until those producers write the store directly.
 */
export function watchHandoffs({
    filters,
    sinceMs,
    follow,
    onEvent,
    base,
    dbPath,
    now = Date.now(),
}: {
    filters: string[];
    sinceMs: number;
    follow: boolean;
    onEvent: (event: WatchedHandoffEvent, names: Map<string, string>) => void;
    base?: string;
    dbPath?: string;
    now?: number;
}): HandoffWatch {
    const db = openHandoffModel(dbPath);
    catchUpHandoffs(db, base);
    const names = new Map<string, string>();
    const idsByName = new Map<string, string>();
    const seen = new Set<string>();

    const rename = (id: string, name: string | null) => {
        const previous = names.get(id);

        if (previous !== undefined && idsByName.get(previous) === id) {
            idsByName.delete(previous);
        }

        if (name) {
            names.set(id, name);
            idsByName.set(name, id);
        } else {
            names.delete(id);
        }
    };

    const learn = (event: WatchedHandoffEvent) => {
        if (event.ev === "post" && event.name) {
            rename(event.id, event.name);
        } else if (event.ev === "modify_handoff" && event.name !== undefined) {
            rename(event.id, event.name);
        }
    };

    for (const handoff of listHandoffRows(db)) {
        rename(handoff.id, handoff.name ?? null);
    }

    const wanted = new Set(
        filters.map((filter) => {
            const id = filter.startsWith("h_") ? filter : `h_${filter}`;
            return idsByName.get(filter) ?? id;
        })
    );
    const nameFilters = new Set(filters);
    // A name posted or given by a rename after the watch started is not in `wanted`, so a live event also
    // matches by its current name. The replay does not: its events can carry a name the handoff no longer has.
    const matches = (event: WatchedHandoffEvent, live: boolean): boolean => {
        if (wanted.size === 0 || wanted.has(event.id)) {
            return true;
        }

        const name = live ? names.get(event.id) : undefined;
        return name !== undefined && nameFilters.has(name);
    };
    const deliver = (event: WatchedHandoffEvent, live: boolean) => {
        if (live) {
            learn(event);
        }

        if (seen.has(event.uid) || !matches(event, live)) {
            return;
        }

        seen.add(event.uid);
        onEvent(event, names);
    };

    // The live cursor is the head before the replay, so a change written during it is read again; `seen` drops it.
    let cursor = journalHead(db);

    if (sinceMs > 0) {
        const cutoff = new Date(now - sinceMs).toISOString();

        for (const event of handoffEventsFromFeed(db, cursorBefore(db, cutoff), cutoff).events) {
            deliver(event, false);
        }
    }

    if (!follow) {
        db.close();
        return { names, close: () => {} };
    }

    const timer = setInterval(() => {
        try {
            catchUpHandoffs(db, base);
            const read = handoffEventsFromFeed(db, cursor);
            cursor = read.cursor;

            for (const event of read.events) {
                deliver(event, true);
            }
        } catch (err) {
            log.warn({ err }, "handoff watch could not read the change feed");
        }
    }, FOLLOW_POLL_MS);

    log.debug({ filters: [...wanted], sinceMs, cursor }, "handoff watch started");
    return {
        names,
        close: () => {
            clearInterval(timer);
            db.close();
        },
    };
}
