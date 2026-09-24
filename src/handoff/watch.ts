import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRollingJsonlStream } from "@genesiscz/utils/fs/rolling-jsonl-stream";
import { parseJsonlChunk } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { handoffLogDir, todayHandoffLogFile } from "./log-store";
import type { HandoffEvent } from "./types";

const log = logger.child({ component: "handoff:watch" });
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const NAME_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

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

/** Every event in the day files from `sinceMs` ago until now, oldest first. */
export function readHandoffEvents(sinceMs: number, base?: string, now = Date.now()): HandoffEvent[] {
    const dir = handoffLogDir(base);

    if (sinceMs <= 0 || !existsSync(dir)) {
        return [];
    }

    const cutoff = now - sinceMs;
    const firstDay = new Date(cutoff).toISOString().slice(0, 10);
    const events: HandoffEvent[] = [];

    for (const name of readdirSync(dir).sort()) {
        const day = DAY_FILE.exec(name)?.[1];

        if (!day || day < firstDay) {
            continue;
        }

        try {
            const { values } = parseJsonlChunk<HandoffEvent>(readFileSync(join(dir, name)));

            for (const event of values) {
                if (Date.parse(event.ts) >= cutoff) {
                    events.push(event);
                }
            }
        } catch (err) {
            log.warn({ err, file: name }, "handoff day file unreadable");
        }
    }

    return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describe(event: HandoffEvent): string {
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
        default:
            return "";
    }
}

export function formatHandoffEvent(event: HandoffEvent, names: Map<string, string>): string {
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
 * Replay `sinceMs` of history, then follow the live log. `filters` are handoff ids (with or
 * without `h_`) or readable names; empty follows every handoff. Events are de-duplicated by uid,
 * so the replay and the live tail can overlap safely.
 */
export function watchHandoffs({
    filters,
    sinceMs,
    follow,
    onEvent,
    base,
}: {
    filters: string[];
    sinceMs: number;
    follow: boolean;
    onEvent: (event: HandoffEvent, names: Map<string, string>) => void;
    base?: string;
}): HandoffWatch {
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

    const learn = (event: HandoffEvent) => {
        if (event.ev === "post" && event.name) {
            rename(event.id, event.name);
        } else if (event.ev === "modify_handoff" && event.name !== undefined) {
            rename(event.id, event.name);
        }
    };

    for (const event of readHandoffEvents(NAME_LOOKBACK_MS, base)) {
        learn(event);
    }

    const wanted = new Set(
        filters.map((filter) => {
            const id = filter.startsWith("h_") ? filter : `h_${filter}`;
            return idsByName.get(filter) ?? id;
        })
    );
    const nameFilters = new Set(filters);
    // A name posted or given by a rename after the watch started is not in `wanted`, so a live event also
    // matches by its current name. The replay does not: re-learning history rewinds `names` to old names.
    const matches = (event: HandoffEvent, live: boolean): boolean => {
        if (wanted.size === 0 || wanted.has(event.id)) {
            return true;
        }

        const name = live ? names.get(event.id) : undefined;
        return name !== undefined && nameFilters.has(name);
    };
    const deliver = (event: HandoffEvent, live: boolean) => {
        learn(event);

        if (seen.has(event.uid) || !matches(event, live)) {
            return;
        }

        seen.add(event.uid);
        onEvent(event, names);
    };

    // The tailer pins its offset synchronously and delivers on a later tick, so starting it before
    // the synchronous replay leaves no gap; anything both paths see is dropped by `seen`.
    const stream = follow
        ? createRollingJsonlStream<HandoffEvent>({
              fileForNow: () => todayHandoffLogFile(base),
              onLine: (event) => deliver(event, true),
          })
        : null;

    for (const event of readHandoffEvents(sinceMs, base)) {
        deliver(event, false);
    }

    if (!stream) {
        return { names, close: () => {} };
    }

    log.debug({ filters: [...wanted], sinceMs }, "handoff watch started");
    return { names, close: () => stream.close() };
}
