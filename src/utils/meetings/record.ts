import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";
import { dictionaryLevelSchema } from "@genesiscz/utils/transcribe/dictionary";
import { z } from "zod";
import { projectNameSchema } from "./config";

const { log } = logger.scoped("meetings-record");

export const MEETING_FILE = "meeting.json";

/** Who created the record. */
export const MEETING_CREATORS = ["new", "link", "record", "autostart"] as const;
export type MeetingCreator = (typeof MEETING_CREATORS)[number];

const isoTime = z.string().min(1);

const participantSchema = z.object({
    name: z.string().min(1),
    self: z.boolean().optional(),
    /** Where the name came from: a source id, "calendar", or "user". */
    from: z.array(z.string()).default([]),
});

const calendarSchema = z.object({
    /** "apple-calendar", or the id of the source that named the event. */
    from: z.string(),
    eventId: z.string().optional(),
    calendar: z.string().optional(),
    title: z.string().optional(),
    start: isoTime.optional(),
    end: isoTime.optional(),
    attendees: z.array(z.string()).default([]),
    conferenceUrl: z.string().optional(),
});

export const CONTEXT_KINDS = ["file", "url", "note"] as const;

const contextSchema = z.object({
    id: z.string().regex(/^c\d+$/),
    kind: z.enum(CONTEXT_KINDS),
    /** An absolute path, a URL, or the note text itself. A file is referenced, never copied. */
    ref: z.string().min(1),
    title: z.string().optional(),
    note: z.string().optional(),
    addedAt: isoTime,
    addedBy: z.enum(["user", "record", "source"]),
});

export const ITEM_STATUSES = ["suggested", "confirmed", "rejected"] as const;

const itemBase = {
    id: z.string().regex(/^i\d+$/),
    status: z.enum(ITEM_STATUSES),
    /** 0 to 1. */
    confidence: z.number().min(0).max(1).optional(),
    /** The rules that produced or scored the item, so a person can see why. */
    rules: z.array(z.string()).default([]),
    evidence: z.record(z.string(), z.unknown()).optional(),
    suggestedAt: isoTime,
    decidedAt: isoTime.optional(),
};

/** A suggestion a rule made and a person decides: confirm or reject. */
export const meetingItemSchema = z.discriminatedUnion("kind", [
    /** A time range of one label that belongs to someone else. */
    z.object({
        kind: z.literal("speaker-range"),
        label: z.string(),
        fromSec: z.number(),
        toSec: z.number(),
        /** Whose voice it is. Empty until a rule or a person knows; confirming needs it. */
        speaker: z.string().optional(),
        /** Who could it be: the people in the call during the range. */
        candidates: z.array(z.string()).optional(),
        ...itemBase,
    }),
    /** Two lines that are one sentence cut by diarization. */
    z.object({
        kind: z.literal("join"),
        atSec: z.number(),
        speaker: z.string().optional(),
        joined: z.string().optional(),
        ...itemBase,
    }),
    /** A misheard term and its proposed spelling. */
    z.object({
        kind: z.literal("term"),
        atSec: z.number().optional(),
        heard: z.string(),
        proposed: z.string(),
        ...itemBase,
    }),
]);
export type MeetingItem = z.infer<typeof meetingItemSchema>;

const historySchema = z.object({ at: isoTime, command: z.string(), change: z.string() });

export const meetingRecordSchema = z.object({
    version: z.literal(1).default(1),
    id: z.string().min(1),
    title: z.string(),
    project: projectNameSchema.optional(),
    start: isoTime,
    end: isoTime.optional(),
    createdAt: isoTime,
    createdBy: z.enum(MEETING_CREATORS),
    /** One block per source, written by that source. Only that source reads its keys. */
    sources: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    calendar: calendarSchema.optional(),
    participants: z.array(participantSchema).default([]),
    context: z.array(contextSchema).default([]),
    /** Renames for this meeting. A rename is a person's act, so it has no status. */
    speakers: z.object({ labels: z.record(z.string(), z.string()).default({}) }).prefault({}),
    /** The meeting's own dictionary level, over the project's and the global one. */
    dictionary: dictionaryLevelSchema.optional(),
    items: z.array(meetingItemSchema).default([]),
    /** Written by `record stop`; its shape is owned by the recorder. */
    recording: z.record(z.string(), z.unknown()).optional(),
    /** One line per command that changed the record. Never rewritten. */
    history: z.array(historySchema).default([]),
});
export type MeetingRecord = z.infer<typeof meetingRecordSchema>;
export type MeetingCalendar = z.infer<typeof calendarSchema>;
export type MeetingParticipant = z.infer<typeof participantSchema>;
export type MeetingContext = z.infer<typeof contextSchema>;

const SLUG_MAX = 40;

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

/** `my meeting – Změny` becomes `my-meeting-zmeny`: no diacritics, lower case, whole words up to 40 characters. */
export function titleSlug(title: string): string {
    const slug = title
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (slug.length <= SLUG_MAX) {
        return slug || "meeting";
    }

    const cut = slug.slice(0, SLUG_MAX + 1);
    const lastBreak = cut.lastIndexOf("-");
    return lastBreak > 0 ? cut.slice(0, lastBreak) : slug.slice(0, SLUG_MAX);
}

/** The folder name and id: local start time, then the title slug. */
export function meetingId(start: string, title: string): string {
    const d = new Date(start);
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
    return `${stamp}-${titleSlug(title)}`;
}

/** A source reference: `wisprflow:1a2b3c4d`. */
export function parseSourceRef(ref: string): { source: string; id: string } | undefined {
    const match = /^([a-z][a-z0-9-]*):(.+)$/.exec(ref);
    return match ? { source: match[1]!, id: match[2]! } : undefined;
}

export interface MeetingChange {
    command: string;
    change: string;
}

/**
 * The meeting records under `~/.genesis-tools/meetings/<id>/meeting.json`. Every write goes through `update()`: under
 * the meeting's lock, validated, with one history line.
 */
export class MeetingStore {
    readonly storage: Storage;

    constructor(storage = new Storage("meetings")) {
        this.storage = storage;
    }

    get root(): string {
        return this.storage.getBaseDir();
    }

    folder(id: string): string {
        return join(this.root, id);
    }

    path(id: string): string {
        return join(this.folder(id), MEETING_FILE);
    }

    /** Every readable record, newest first. A record that does not parse is logged and left out. */
    list(): MeetingRecord[] {
        if (!existsSync(this.root)) {
            return [];
        }

        const records: MeetingRecord[] = [];

        for (const entry of readdirSync(this.root, { withFileTypes: true })) {
            if (!entry.isDirectory() || !existsSync(this.path(entry.name))) {
                continue;
            }

            const record = this.read(entry.name);

            if (record) {
                records.push(record);
            }
        }

        return records.sort((a, b) => b.start.localeCompare(a.start));
    }

    read(id: string): MeetingRecord | undefined {
        const path = this.path(id);

        if (!existsSync(path)) {
            return undefined;
        }

        const parsed = meetingRecordSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8")));

        if (!parsed.success) {
            log.warn({ path, issues: parsed.error.issues }, "meeting record does not validate; left out");
            return undefined;
        }

        return parsed.data;
    }

    /**
     * Finds a meeting by its id, a unique prefix of it, `last`, or a source reference (`wisprflow:1a2b3c4d`, matched
     * on the start of `sources.<source>.meetingId`). Throws when a prefix fits several.
     */
    resolve(ref: string): MeetingRecord | undefined {
        const records = this.list();

        if (ref === "last") {
            return records[0];
        }

        const source = parseSourceRef(ref);
        const matches = source
            ? records.filter((record) => {
                  const id = record.sources[source.source]?.meetingId;
                  return typeof id === "string" && id.startsWith(source.id);
              })
            : records.filter((record) => record.id === ref || record.id.startsWith(ref));
        const exact = matches.find((record) => record.id === ref);

        if (exact) {
            return exact;
        }

        if (matches.length > 1) {
            throw new Error(
                `"${ref}" fits ${matches.length} meetings: ${matches.map((record) => record.id).join(", ")}`
            );
        }

        return matches[0];
    }

    /** Creates a record. A second meeting with the same start and title gets `-2`, `-3` … on its id. */
    async create(
        fields: Pick<MeetingRecord, "title" | "start" | "createdBy"> & Partial<MeetingRecord>,
        change: MeetingChange
    ): Promise<MeetingRecord> {
        const base = meetingId(fields.start, fields.title);
        let id = base;

        for (let n = 2; existsSync(this.folder(id)); n += 1) {
            id = `${base}-${n}`;
        }

        const now = new Date().toISOString();
        const record = meetingRecordSchema.parse({
            ...fields,
            id,
            createdAt: now,
            history: [{ at: now, command: change.command, change: change.change }],
        });

        mkdirSync(this.folder(id), { recursive: true });
        await this.storage.withFileLock({ file: this.path(id), fn: async () => this.write(record) });
        log.debug({ id, createdBy: record.createdBy }, "meeting created");
        return record;
    }

    /** Changes one record under its lock. The result must validate, or nothing is written. */
    async update(id: string, change: MeetingChange, mutate: (record: MeetingRecord) => void): Promise<MeetingRecord> {
        return this.storage.withFileLock({
            file: this.path(id),
            fn: async () => {
                const current = this.read(id);

                if (!current) {
                    throw new Error(`No meeting ${id} (or its ${MEETING_FILE} does not validate): ${this.path(id)}`);
                }

                mutate(current);
                current.history.push({ at: new Date().toISOString(), command: change.command, change: change.change });
                const record = meetingRecordSchema.parse(current);
                this.write(record);
                log.debug({ id, command: change.command }, "meeting updated");
                return record;
            },
        });
    }

    private write(record: MeetingRecord): void {
        atomicWriteFileSync(this.path(record.id), `${SafeJSON.stringify(record, null, 4)}\n`);
    }
}

/** The next free id in a list: `c1`, `c2` … or `i1`, `i2` …. */
export function nextId(prefix: "c" | "i", taken: Array<{ id: string }>): string {
    const highest = taken.reduce((max, entry) => Math.max(max, Number(entry.id.slice(1)) || 0), 0);
    return `${prefix}${highest + 1}`;
}
