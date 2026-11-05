import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";
import { dictionaryLevelSchema } from "@genesiscz/utils/transcribe/dictionary";
import { z } from "zod";
import { calendarEntrySchema, calendarPersonSchema } from "./calendar-entry";
import { projectNameSchema } from "./config";
import { CHANNEL_LAYOUTS } from "./energy";
import { MEETING_PLATFORM_IDS } from "./platform";

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
    /** The attendees with their emails, when the calendar gives them. `attendees` keeps the names for older readers. */
    people: z.array(calendarPersonSchema).optional(),
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

/** What a question asks about: whose voice, which word, or what was said. */
export const QUESTION_TOPICS = ["speaker", "term", "text"] as const;
export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

const itemIdSchema = z.string().regex(/^i\d+$/);

const itemBase = {
    id: itemIdSchema,
    status: z.enum(ITEM_STATUSES),
    /** 0 to 1. */
    confidence: z.number().min(0).max(1).optional(),
    /** The rules that produced or scored the item, so a person can see why. */
    rules: z.array(z.string()).default([]),
    evidence: z.record(z.string(), z.unknown()).optional(),
    suggestedAt: isoTime,
    decidedAt: isoTime.optional(),
    /**
     * The confirm or reject that decided the item: its token, which an Undo names (`reopen --token`), and the fields
     * it changed as they were before, which the Undo puts back.
     */
    decision: z
        .object({
            token: z.string().min(1),
            previous: z.object({
                status: z.enum(ITEM_STATUSES),
                decidedAt: isoTime.optional(),
                speaker: z.string().optional(),
                proposed: z.string().optional(),
            }),
        })
        .optional(),
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
    /**
     * A label that does not track one person over a stretch: diarization put several voices under it there. Its lines
     * in the stretch count as unlabeled: the rules take no hint from the label, and the transcript marks each one no
     * range or join gives a voice as unclear. One item stands for what would otherwise be a range per line.
     */
    z.object({
        kind: z.literal("label"),
        label: z.string(),
        fromSec: z.number(),
        toSec: z.number(),
        meaningless: z.literal(true),
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
        /** The right spelling. Absent for a word no dictionary layer accepts and no term resembles: asked by ear. */
        proposed: z.string().optional(),
        /** `line`: the spelling fixes only the line at `atSec`. Absent, it fixes the words wherever they are heard. */
        scope: z.enum(["everywhere", "line"]).optional(),
        /** Shown after the heard words, which stay as said: `lomeno type` means `/{type}`. */
        meaning: z.string().min(1).optional(),
        /** The heard words read a document line aloud: its exact text replaces them, with the source. */
        quote: z.object({ text: z.string().min(1), source: z.string().min(1) }).optional(),
        ...itemBase,
    }),
    /**
     * A question a person answers by ear (`tools meetings listen`). Open while suggested; confirmed once answered,
     * rejected when skipped. The answer confirms or rejects the items in `decides`.
     */
    z.object({
        kind: z.literal("question"),
        about: z.enum(QUESTION_TOPICS),
        fromSec: z.number(),
        toSec: z.number(),
        question: z.string().min(1),
        /** The words in question (about a term or text), as the transcript shows them; marked until answered. */
        heard: z.string().min(1).optional(),
        choices: z.array(z.string()).default([]),
        decides: z.array(itemIdSchema).default([]),
        answer: z.string().optional(),
        comment: z.string().optional(),
        /** What `listen` plays when the range is long: the longest line in it. Absent: the whole range. */
        clip: z.object({ fromSec: z.number(), toSec: z.number() }).optional(),
        /** Value of information, (1 − confidence) × impact × reach: `listen` asks the highest first. */
        priority: z.number().optional(),
        /** The evidence shape (top choices and who was present): one answer settles every question that shares it. */
        signature: z.string().optional(),
        ...itemBase,
    }),
]);
export type MeetingItem = z.infer<typeof meetingItemSchema>;

/** Why a recorded span ended: asked for (`record stop`, a stop command, a signal), a pause, failed captures, an error. */
export const RECORDING_STOP_REASONS = ["requested", "paused", "failed", "error"] as const;
export type RecordingStopReason = (typeof RECORDING_STOP_REASONS)[number];

const recordingSpanSchema = z.object({
    from: isoTime,
    to: isoTime.optional(),
    stopReason: z.enum(RECORDING_STOP_REASONS).optional(),
});
export type RecordingSpan = z.infer<typeof recordingSpanSchema>;
/** One stretch a display was captured: a live switch or a follow-focus frame on another display starts the next. */
export const recordingDisplaySpanSchema = recordingSpanSchema.extend({ displayId: z.number() });
export type RecordingDisplaySpan = z.infer<typeof recordingDisplaySpanSchema>;

/**
 * The screen recording of a meeting, owned by the recorder. Every key is optional and unknown keys stay, because records
 * written before this schema hold a subset of it (`display`, one index, instead of `displays`).
 */
export const recordingBlockSchema = z
    .object({
        startedAt: isoTime.optional(),
        stoppedAt: isoTime.optional(),
        status: z.enum(["recording", "paused", "stopped"]).optional(),
        stopReason: z.enum(RECORDING_STOP_REASONS).optional(),
        backend: z.string().optional(),
        /** The display policy of the last start: `all`, `follow-focus`, `main` or an index. */
        displayPolicy: z.union([z.string(), z.number()]).optional(),
        /** The screen index of a recording made before `displays`. */
        display: z.number().optional(),
        displays: z.array(z.object({ id: z.number(), name: z.string(), frames: z.number().default(0) })).optional(),
        framesDir: z.string().optional(),
        ocr: z.string().optional(),
        frames: z.number().optional(),
        bytes: z.number().optional(),
        /** Each stretch the recorder ran, over all its starts. */
        spans: z.array(recordingSpanSchema).optional(),
        /** Capture intervals for each display; absent in older recordings. */
        displaySpans: z.array(recordingDisplaySpanSchema).optional(),
        warning: z.string().optional(),
        clock: z.object({ source: z.string(), startedAt: isoTime }).optional(),
        /** When the failure notice of the current failure episode was posted; cleared by a piece that recorded. */
        failureNotifiedAt: isoTime.optional(),
        /**
         * The moments marked while it recorded (`marker.add`), over all its starts, at their wall-clock time; the
         * meeting's recording.json gets them at their movie time.
         */
        markers: z.array(z.object({ at: isoTime, label: z.string() })).optional(),
    })
    .loose();
export type RecordingBlock = z.infer<typeof recordingBlockSchema>;

const historySchema = z.object({ at: isoTime, command: z.string(), change: z.string() });

/** The states of one question in the decision inbox. */
export const ASK_OUTCOMES = ["pending", "applied", "cancelled", "timeout", "failed"] as const;

/**
 * How the meeting got its project: the one question asked for it in the decision inbox, with what it offered, and the
 * Wispr folder step after the answer. Only `src/meetings/lib/assign.ts` writes it.
 */
const assignSchema = z.object({
    ask: z
        .object({
            formId: z.string().min(1),
            askedAt: isoTime,
            outcome: z.enum(ASK_OUTCOMES).default("pending"),
            answeredAt: isoTime.optional(),
            /** Why posting failed; the next sweep after ten minutes asks again. */
            error: z.string().optional(),
            /** The ranked proposals the question listed, each with its reasons as text. */
            proposals: z.array(z.object({ project: z.string(), score: z.number(), reasons: z.array(z.string()) })),
            /** The calendar entries that overlapped the meeting; the answer picks one by its place here. */
            calendars: z.array(calendarEntrySchema).default([]),
            /** The source folder the meeting was in that no project had; the answer may pair it. */
            folder: z.object({ source: z.string(), folder: z.string() }).optional(),
        })
        .optional(),
    /**
     * The meeting's project has a folder in the source and the meeting is in none: the owner moves it by hand (no
     * source can be changed from here), and the next sync that sees it in a folder asks to pair that folder.
     */
    folder: z
        .object({
            source: z.string(),
            project: z.string(),
            state: z.enum(["waiting", "asked", "paired", "declined"]),
            since: isoTime,
            folder: z.string().optional(),
            formId: z.string().optional(),
        })
        .optional(),
});
export type MeetingAssign = z.infer<typeof assignSchema>;

export const meetingRecordSchema = z.object({
    version: z.literal(1).default(1),
    id: z.string().min(1),
    title: z.string(),
    project: projectNameSchema.optional(),
    /** Labels inside the project ("Checkout 2.0"): a meeting has one project and any labels. */
    labels: z.array(z.string().trim().min(1)).default([]),
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
    /** Who was in the call and when (Teams), on the transcript clock. The user is stored under their own name. */
    attendance: z
        .object({
            from: z.string(),
            people: z.array(
                z.object({
                    name: z.string(),
                    self: z.boolean().optional(),
                    fromSec: z.number(),
                    toSec: z.number(),
                    joinedAtExact: z.boolean().optional(),
                    leftAtExact: z.boolean().optional(),
                })
            ),
        })
        .optional(),
    /** One section per interval between two joins or leaves, derived from `attendance`: who is present then. */
    sections: z.array(z.object({ fromSec: z.number(), toSec: z.number(), present: z.array(z.string()) })).optional(),
    /** The call platform: set from the source (Wispr's `meta.platform`) or by hand; it picks the attendance reader. */
    platform: z.enum(MEETING_PLATFORM_IDS).optional(),
    /** What was measured about the recording itself. */
    evidence: z
        .object({
            /** Which audio channel is the user's microphone, calibrated on this recording's tagged segments. */
            channels: z
                .object({
                    layout: z.enum(CHANNEL_LAYOUTS),
                    micMedian: z.number().optional(),
                    systemMedian: z.number().optional(),
                    segments: z.object({ mic: z.number(), system: z.number() }),
                    reason: z.string().optional(),
                    /**
                     * The stretches of 5 min or more where the call's channel stayed silent while the microphone
                     * heard speech (`silentCallSpans`): the call played through the room, so E1 says nothing there.
                     * Absent in records calibrated before it was stored.
                     */
                    callSilent: z.array(z.object({ fromSec: z.number(), toSec: z.number() })).optional(),
                })
                .optional(),
        })
        .optional(),
    recording: recordingBlockSchema.optional(),
    assign: assignSchema.optional(),
    /**
     * The notes `meetings export` wrote, one per file: the sha256 of what it wrote, so the next export can tell an
     * untouched note (replaced) from one a person edited (kept).
     */
    exports: z.array(z.object({ path: z.string().min(1), sha256: z.string().min(1), at: isoTime })).optional(),
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
        return this.listBounded({}).records;
    }

    /** Folder dates bound discovery before JSON hydration. A record whose start is edited after creation keeps
     * its folder date for this bound. One day of margin covers local/UTC time-zone differences. Undated folders
     * are treated as today and read. `olderMeetings` counts excluded record folders without parsing their JSON. */
    listBounded({ since, limit }: { since?: Date; limit?: number }): {
        records: MeetingRecord[];
        olderMeetings: number;
    } {
        const records: MeetingRecord[] = [];
        let olderMeetings = 0;
        if (!existsSync(this.root)) {
            return { records, olderMeetings };
        }
        const cutoff = since ? new Date(since.getTime() - 86_400_000).toISOString().slice(0, 10) : undefined;
        const folders = readdirSync(this.root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(this.path(entry.name)))
            .map((entry) => ({
                id: entry.name,
                day: /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}/.test(entry.name) ? entry.name.slice(0, 10) : undefined,
            }))
            .sort((a, b) => (b.day ?? "9999").localeCompare(a.day ?? "9999") || b.id.localeCompare(a.id));
        for (const folder of folders) {
            if (cutoff && folder.day && folder.day < cutoff) {
                olderMeetings++;
                continue;
            }
            if (limit !== undefined && records.length >= Math.max(0, limit)) {
                continue;
            }
            const record = this.read(folder.id);
            if (record) {
                records.push(record);
            }
        }
        return { records: records.sort((a, b) => b.start.localeCompare(a.start)), olderMeetings };
    }

    read(id: string): MeetingRecord | undefined {
        const path = this.path(id);

        if (!existsSync(path)) {
            return undefined;
        }

        const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
        if (raw && typeof raw === "object" && "recording" in raw) {
            const recording = raw.recording;
            if (recording && typeof recording === "object" && "status" in recording && recording.status === "failed") {
                raw.recording = { ...recording, status: "stopped", stopReason: "error" };
            }
        }
        const parsed = meetingRecordSchema.safeParse(raw);

        if (!parsed.success) {
            log.warn({ path, issues: parsed.error.issues }, "meeting record does not validate; left out");
            return undefined;
        }

        return parsed.data;
    }

    /**
     * What to change when `GENESIS_TOOLS_HOME` points one level too deep: the records sit in `<home>/meetings/`,
     * while the tool reads `<home>/.genesis-tools/meetings/`. Undefined for any other layout.
     */
    layoutHint(): string | undefined {
        if (!env.tools.hasExplicitHome()) {
            return undefined;
        }

        const home = env.tools.getHome();
        const misplaced = join(home, basename(this.root));

        if (resolve(misplaced) === resolve(this.root) || !existsSync(misplaced)) {
            return undefined;
        }

        const holdsRecords = readdirSync(misplaced, { withFileTypes: true }).some(
            (entry) => entry.isDirectory() && existsSync(join(misplaced, entry.name, MEETING_FILE))
        );

        if (!holdsRecords) {
            return undefined;
        }

        const parent = basename(home) === ".genesis-tools" ? dirname(home) : "the folder that holds .genesis-tools";
        return `GENESIS_TOOLS_HOME is ${home}, so meetings are read from ${this.root}, but the records are in ${misplaced}. GENESIS_TOOLS_HOME names the folder above .genesis-tools: set it to ${parent}, or unset it.`;
    }

    /**
     * Finds a meeting by its id, a unique prefix of it, `last`, or a source reference (`wisprflow:1a2b3c4d`, matched
     * on the start of `sources.<source>.meetingId`). Throws when a prefix fits several, and with `layoutHint` when
     * nothing fits and the records sit one level off.
     */
    resolve(ref: string): MeetingRecord | undefined {
        const records = this.list();

        if (ref === "last") {
            return records[0] ?? this.noMatch(ref);
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

        return matches[0] ?? this.noMatch(ref);
    }

    /** Nothing fits `ref`: undefined, or the `layoutHint` as an error when the records sit one level off. */
    private noMatch(ref: string): undefined {
        const hint = this.layoutHint();

        if (hint) {
            throw new Error(`No meeting "${ref}". ${hint}`);
        }

        return undefined;
    }

    /** Creates a record. A second meeting with the same start and title gets `-2`, `-3` … on its id. */
    async create(
        fields: Pick<MeetingRecord, "title" | "start" | "createdBy"> & Partial<MeetingRecord>,
        change: MeetingChange
    ): Promise<MeetingRecord> {
        const base = meetingId(fields.start, fields.title);
        let id = base;
        const now = new Date().toISOString();
        const record = meetingRecordSchema.parse({
            ...fields,
            id,
            createdAt: now,
            history: [{ at: now, command: change.command, change: change.change }],
        });

        // The folder is the reservation: a plain mkdir fails with EEXIST when another process took the id first.
        // Meetings hold screen captures and transcripts, so only the owner may read them.
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        chmodSync(this.root, 0o700);

        for (let n = 2; ; n += 1) {
            try {
                mkdirSync(this.folder(id), { mode: 0o700 });
                break;
            } catch (err) {
                if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") {
                    throw err;
                }

                id = `${base}-${n}`;
            }
        }

        record.id = id;
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

    /**
     * Names a diarization label for this meeting. The label's own name removes the rename, so the transcript shows
     * the source label again.
     */
    async renameSpeaker(id: string, label: string, name: string): Promise<MeetingRecord> {
        const trimmed = name.trim();

        if (!trimmed) {
            throw new Error(`a rename of ${label} needs a name`);
        }

        return this.update(id, { command: "speakers rename", change: `${label} → ${trimmed}` }, (current) => {
            if (trimmed === label) {
                delete current.speakers.labels[label];
            } else {
                current.speakers.labels[label] = trimmed;
            }
        });
    }

    private write(record: MeetingRecord): void {
        // A store made before the owner-only rule is tightened at its next write.
        chmodSync(this.root, 0o700);
        chmodSync(this.folder(record.id), 0o700);
        atomicWriteFileSync(this.path(record.id), `${SafeJSON.stringify(record, null, 4)}\n`, { mode: 0o600 });
    }
}

/** The next free id in a list: `c1`, `c2` … or `i1`, `i2` …. */
export function nextId(prefix: "c" | "i", taken: Array<{ id: string }>): string {
    const highest = taken.reduce((max, entry) => Math.max(max, Number(entry.id.slice(1)) || 0), 0);
    return `${prefix}${highest + 1}`;
}
