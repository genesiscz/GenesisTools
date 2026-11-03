import { logger } from "@genesiscz/utils/logger";
import type { AttendanceTarget } from "@genesiscz/utils/meetings/platform";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { type Presence, presenceSections } from "@genesiscz/utils/transcribe/speakers";
import { type LoadedPresence, loadPresence } from "./attendance";
import { type LinkedSource, linkedSource, sourceRefOf } from "./sources";

const { log } = logger.scoped("meetings-timeline");

/** Where transcript second 0 came from: the source's own clock, what the recorder stored from it, or the record. */
export type ClockOrigin = "source" | "recording" | "record";

export interface TranscriptClock {
    /** Wall time of transcript second 0. */
    startedAt: string;
    from: ClockOrigin;
    /** The source that gave it, for `source` and `recording`. */
    source?: string;
}

/**
 * The call on the transcript clock: second 0 (asked of the source, which owns its transcript's times), the stays from
 * a platform or a platform's export file, the user named once, and the stays and sections stored once. Every command
 * that maps a wall time to a transcript second, or a stay to a line, goes through here.
 */
export class CallTimeline {
    private constructor(
        private readonly record: MeetingRecord,
        readonly clock: TranscriptClock,
        private readonly end: string | undefined
    ) {}

    /** The clock without asking the source: what the recorder stored from it, else the record's own start. */
    static stored(record: MeetingRecord): CallTimeline {
        const kept = record.recording?.clock;
        return new CallTimeline(
            record,
            kept
                ? { startedAt: kept.startedAt, from: "recording", source: kept.source }
                : { startedAt: record.start, from: "record" },
            record.end
        );
    }

    /**
     * The source's clock: its `recordingClock`, else the start of its meeting. Falls back to the stored clock when the
     * source has no times or cannot be read.
     */
    static async ofSource(record: MeetingRecord, linked: LinkedSource, meeting?: SourceMeeting): Promise<CallTimeline> {
        const clock = await CallTimeline.sourceClock(linked);
        const startedAt = clock?.startedAt ?? meeting?.start;

        if (!startedAt) {
            return CallTimeline.stored(record);
        }

        return new CallTimeline(
            record,
            { startedAt, from: "source", source: linked.source.id },
            meeting?.end ?? record.end
        );
    }

    /** The record's timeline on its linked source's clock, else on the stored one. Never throws. */
    static async forRecord(record: MeetingRecord): Promise<CallTimeline> {
        if (!sourceRefOf(record)) {
            return CallTimeline.stored(record);
        }

        try {
            return await CallTimeline.ofSource(record, await linkedSource(record));
        } catch (err) {
            log.warn({ err, meeting: record.id }, "source unavailable; the stored clock is used");
            return CallTimeline.stored(record);
        }
    }

    /** Transcript second 0 as the source tells it; undefined when it keeps no times or cannot be read now. */
    static async sourceClock(linked: LinkedSource): Promise<TranscriptClock | undefined> {
        try {
            const clock = await linked.source.recordingClock(linked.sourceMeetingId);
            return clock ? { startedAt: clock.startedAt, from: "source", source: linked.source.id } : undefined;
        } catch (err) {
            log.warn({ err, source: linked.source.id }, "recording clock unavailable");
            return undefined;
        }
    }

    /** Wall time of transcript second 0, in ms. */
    get zeroMs(): number {
        return Date.parse(this.clock.startedAt);
    }

    /** The transcript second of a wall time (ms); negative before second 0. */
    secAt(ms: number): number {
        return (ms - this.zeroMs) / 1000;
    }

    /** The wall time (ms) of a transcript second. */
    msAt(sec: number): number {
        return this.zeroMs + sec * 1000;
    }

    /** The call a platform looks up: its title (some find the call by it) and its start on this clock. */
    target(): AttendanceTarget {
        return {
            title: this.record.calendar?.title ?? this.record.title,
            start: this.clock.startedAt,
            ...(this.end ? { end: this.end } : {}),
        };
    }

    /** The user's own name: a platform may know them by email only, or as "self". */
    get selfName(): string | undefined {
        return this.record.participants.find((person) => person.self)?.name;
    }

    /** Stays with the user under their own name. */
    named(stays: Presence[]): Presence[] {
        const self = this.selfName;
        return self ? stays.map((stay) => (stay.self ? { ...stay, name: self } : stay)) : stays;
    }

    /** The stays the record keeps (already named), if any. */
    storedStays(): Presence[] | undefined {
        return this.record.attendance?.people;
    }

    /** Loads stays from a platform id or a platform's export file, named and on this clock. */
    async stays(spec: string): Promise<LoadedPresence> {
        const loaded = await loadPresence(this.target(), spec, this.record.platform);
        return { ...loaded, presence: this.named(loaded.presence) };
    }

    /**
     * Stores stays and the sections derived from them: the user under their own name, an open stay closed at the last
     * known time.
     */
    async store(store: MeetingStore, loaded: LoadedPresence, from: string): Promise<MeetingRecord> {
        const people = this.named(loaded.presence);
        const lastKnown = Math.max(
            ...people.flatMap((stay) => [stay.fromSec, Number.isFinite(stay.toSec) ? stay.toSec : stay.fromSec])
        );
        const stored = people.map((stay) => ({ ...stay, toSec: Number.isFinite(stay.toSec) ? stay.toSec : lastKnown }));
        const sections = presenceSections(stored);
        return store.update(
            this.record.id,
            { command: "attendance", change: `${stored.length} stays, ${sections.length} sections (${loaded.note})` },
            (next) => {
                next.attendance = { from, people: stored };
                next.sections = sections;
            }
        );
    }
}
