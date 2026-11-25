import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingsConfig, MeetingsConfigStore, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { collectEcho } from "@genesiscz/utils/meetings/echo";
import { type ChannelCalibration, channelEnergy, type SilentCallSpan } from "@genesiscz/utils/meetings/energy";
import { type DeviceDecision, mappedRoomDevices, type RoomDevice } from "@genesiscz/utils/meetings/people";
import { PeopleBook, type PeopleBookData, type PeopleMerge } from "@genesiscz/utils/meetings/people-book";
import { AttendanceUnavailableError } from "@genesiscz/utils/meetings/platform";
import {
    JOIN_SOUND_MERGED,
    type JoinPart,
    MEETING_UNCHANGED,
    type MeetingRecord,
    MeetingStore,
} from "@genesiscz/utils/meetings/record";
import { wholeMeetingRoomPeople } from "@genesiscz/utils/meetings/seats";
import type { DictionaryCandidate, MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { ResolvedDictionary } from "@genesiscz/utils/transcribe/dictionary";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";
import { isLeavePhrase, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import { type SummaryPoint, summaryPoints } from "@genesiscz/utils/transcribe/summary";
import { loadPresence } from "./attendance";
import { CallTimeline } from "./call-timeline";
import { identifiedDepartures, matchedCallVoices } from "./departure";
import { callSilentSpans, energyMicShareFor, type MicEnergy, storeCalibration } from "./energy";
import { clockMove, movedValue, toJoinedSec, toPartSec } from "./join-clock";
import { personStays, presenceOf, rosterPresence, speechAfter } from "./person-stays";
import { MEETING_PLATFORMS, platformOfSourceName, speakingEvidence } from "./platforms";
import { missingProjectWarning } from "./project";
import { loadMeetingSound, type MeetingSound, readSoundInputs, type SoundInputs } from "./sound";
import { recordSourceAudio, withPreservedSourceAudio } from "./source-audio";
import { type LinkedSource, linkedSource, type SourceRef, sourceRefOf } from "./sources";
import { assessIndicator } from "./speaker-indicator";
import { configuredWordChecks, type WordCheckChoice, wordCheckFor } from "./word-check";

const { log } = logger.scoped("meetings-opened");
/** The component log, exported so a test can assert the diagnostics this module promises. */
export const openedMeetingLog = log;

export interface CollectOutcome {
    record: MeetingRecord;
    /**
     * One line per step that did something or could not, for the user. `detail`: a failure's full text with the
     * commands that fix it, which the terminal prints under the line and the window keeps behind "Details".
     */
    notes: Array<{ ok: boolean; text: string; detail?: string }>;
}

/**
 * The last attendance attempt's failure in full, as the record's event history keeps it: the error with the commands
 * that fix it. The window shows it only behind "Details"; a warning a person reads is `attendanceWarning`.
 */
export function attendanceDetail(record: MeetingRecord): string | undefined {
    const event = record.history.findLast(
        (one) =>
            one.command === "attendance" ||
            one.command === "attendance-failed" ||
            one.command === "attendance-recovered"
    );
    return event?.command === "attendance-failed" ? event.change : undefined;
}

/** A failed attendance lookup in one short sentence (U3): never a command, an error text or a rule id. */
export function attendanceSentence(platform: MeetingRecord["platform"]): string {
    const call = platform ? MEETING_PLATFORMS[platform].label : "The call";
    return `${call} did not say who joined, so the people come from the transcript.`;
}

/** The last attendance attempt's failure as a person reads it; its full text is `attendanceDetail`. */
export function attendanceWarning(record: MeetingRecord): string | undefined {
    return attendanceDetail(record) === undefined ? undefined : attendanceSentence(record.platform);
}

/** Why an `--attendance-id` cannot be used with this `--attendance`, before anything loads; undefined when it can. */
export function attendanceIdRefusal(spec: string | undefined, attendanceId: string | undefined): string | undefined {
    const selectedId = attendanceId?.trim();

    if (selectedId !== undefined && (!spec || selectedId.length === 0)) {
        return "--attendance-id requires --attendance <platform> and a nonempty id.";
    }

    return undefined;
}

/** One recording of a joined record, opened on its own clock and folder, for a reading of it as it was (polish). */
interface JoinedPartView {
    part: JoinPart;
    /** The part's second 0 on the joined clock, and the next part's (Infinity for the last): the part's window. */
    fromSec: number;
    untilSec: number;
    opened: OpenedMeeting;
}

/** One recording of a joined record as it was before the join (`OpenedMeeting.recordingReading`). */
export interface PartReading {
    /** That recording on its own clock and lines, with the joined record's items of it moved back onto them. */
    opened: OpenedMeeting;
    offsetMs: number;
    toJoinedSec: (sec: number) => number;
    toPartSec: (sec: number) => number;
}

/**
 * The file a span is cut from and where that file's second 0 sits on the record's clock: a plan moved by
 * `clockMove(-offsetMs)` is the same plan on the file's own seconds.
 */
export interface AudioSpan {
    path: string;
    offsetMs: number;
}

/** A plan or an item on the seconds of the file `file` names (`OpenedMeeting.audioAt`); the same value for a file at 0. */
export function onFileClock<T>(value: T, file: AudioSpan): T {
    return file.offsetMs === 0 ? value : movedValue(value, clockMove(-file.offsetMs));
}

/** A plan on a file's seconds back on the record's clock (`onFileClock` the other way). */
export function onRecordClock<T>(value: T, file: AudioSpan): T {
    return file.offsetMs === 0 ? value : movedValue(value, clockMove(file.offsetMs));
}

const PART_READ_ONLY = "A recording of a joined meeting is read only here; change the joined record instead.";

/**
 * The store a part view reads through: a part keeps the id of the record it was, which names its folder (its sound,
 * its caches, its word timings), and every write is refused, so reading a part never changes the joined record.
 */
class JoinedPartStore extends MeetingStore {
    constructor(base: MeetingStore) {
        super(base.storage);
    }

    override async update(): Promise<never> {
        throw new Error(PART_READ_ONLY);
    }

    override async updateIf(): Promise<never> {
        throw new Error(PART_READ_ONLY);
    }

    override async withRecords(): Promise<never> {
        throw new Error(PART_READ_ONLY);
    }

    override async create(): Promise<never> {
        throw new Error(PART_READ_ONLY);
    }

    override async createWithFiles(): Promise<never> {
        throw new Error(PART_READ_ONLY);
    }
}

/**
 * The joined record's label names as one recording reads them: a label the join renamed for this recording
 * (`[own, joined]` pairs) names its person under the recording's own label again, in place of the other recording's.
 */
function partSpeakerNames(
    names: Readonly<Record<string, string>>,
    renamed: ReadonlyArray<[string, string]>
): Record<string, string> {
    const own = { ...names };

    for (const [label, joined] of renamed) {
        delete own[label];
        delete own[joined];

        if (Object.hasOwn(names, joined)) {
            own[label] = names[joined]!;
        }
    }

    return own;
}

/** A joined record as the single recording `part` was: its id, source, preserved sound and channel calibration. */
function partRecord(joined: MeetingRecord, part: JoinPart): MeetingRecord {
    return {
        ...joined,
        id: part.record,
        version: 1,
        join: undefined,
        start: part.zeroAt,
        sources: { [part.sourceId]: { meetingId: part.sourceMeetingId } },
        audio: part.audio ? { sources: { [part.sourceId]: part.audio } } : undefined,
        evidence: part.channels ? { channels: part.channels } : undefined,
        items: [],
        participants: [],
        attendance: undefined,
        sections: undefined,
        seats: undefined,
    };
}

/**
 * One meeting, opened once: its record and, read lazily and once, the linked source's meeting, the evidence (filtered
 * by the platform), the call timeline with presence, the calibrated energy share, the silent call stretches, the
 * dictionary, the summary points and the word check. Reading never writes the record: collecting the call's facts and
 * storing the channel calibration are the explicit steps `collect` and `calibrate`.
 */
export class OpenedMeeting {
    private current: MeetingRecord;
    private peopleBookOnce?: PeopleBookData;
    private devicesOnce?: RoomDevice[];
    private linkedOnce?: Promise<LinkedSource>;
    private meetingOnce?: Promise<SourceMeeting>;
    private evidenceOnce?: Promise<MeetingEvidence | null>;
    private energyOnce?: Promise<MicEnergy>;
    private timelineOnce?: Promise<CallTimeline>;
    private configOnce?: Promise<MeetingsConfig>;
    private soundOnce?: Promise<MeetingSound>;
    private soundInputsOnce?: Promise<SoundInputs>;
    /** A platform's attendance per choice (spec and id): one read serves the statistics and the evidence alike. */
    private readonly attendanceOnce = new Map<string, ReturnType<typeof loadPresence>>();

    private constructor(
        readonly store: MeetingStore,
        record: MeetingRecord,
        linked: LinkedSource | undefined
    ) {
        this.current = record;

        if (linked) {
            this.linkedOnce = Promise.resolve(linked);
        }
    }

    /** Opens a record. `linked` replaces the source the record names (a fake source in tests). */
    static of(
        store: MeetingStore,
        record: MeetingRecord,
        linked?: LinkedSource,
        config?: MeetingsConfig
    ): OpenedMeeting {
        const opened = new OpenedMeeting(store, record, linked);
        if (config) {
            opened.configOnce = Promise.resolve(config);
        }
        return opened;
    }

    /** The record as the last explicit step left it. */
    get record(): MeetingRecord {
        return this.current;
    }

    private get peopleBook(): PeopleBookData {
        this.peopleBookOnce ??= new PeopleBook({ storage: this.store.storage }).read();
        return this.peopleBookOnce;
    }

    get deviceHistory(): DeviceDecision[] {
        return this.peopleBook.devices;
    }

    /** The people book's merges: two names the user made one person (`people merge`). */
    get peopleMerges(): PeopleMerge[] {
        return this.peopleBook.merges;
    }

    get roomDevices(): RoomDevice[] {
        this.devicesOnce ??= mappedRoomDevices(this.deviceHistory);
        return this.devicesOnce;
    }

    /** The linked source meeting, without loading the source; undefined when no source names one. */
    get sourceRef(): SourceRef | undefined {
        return sourceRefOf(this.current);
    }

    /**
     * The sound refusal of a record joined before its sound moved into its folder (`JOIN_SOUND_MERGED`): its later
     * recording still sits in that recording's own folder, so no reader may take this record's sound for the meeting's.
     */
    private unmergedSound(): Error | undefined {
        const join = this.current.join;
        return join && join.version < JOIN_SOUND_MERGED
            ? new Error(
                  `${this.current.id} was joined by an older version, which left the later recording's sound in its own folder; move it in once: ${toolCommand("meetings", "join", this.current.id, "--repair")}`
              )
            : undefined;
    }

    /** The linked source and its meeting id. Throws a message ready to print when none is linked. */
    linked(): Promise<LinkedSource> {
        this.linkedOnce ??= linkedSource(this.current);
        return this.linkedOnce;
    }

    /** The source's meeting with its transcript, on the source's own labels. */
    meeting(): Promise<SourceMeeting> {
        this.meetingOnce ??= this.linked().then(({ source, sourceMeetingId }) => {
            log.debug({ meeting: this.current.id, source: source.id, sourceMeetingId }, "loading the source meeting");
            return source.load(sourceMeetingId);
        });
        return this.meetingOnce;
    }

    /** The source's speaker evidence as it keeps it, every reading included. */
    sourceEvidence(): Promise<MeetingEvidence | null> {
        this.evidenceOnce ??= this.linked().then(async ({ source, sourceMeetingId }) =>
            withPreservedSourceAudio(
                this.current,
                await source.evidence(sourceMeetingId).catch((error: unknown) => {
                    if (!recordSourceAudio(this.current)) {
                        throw error;
                    }
                    log.debug({ error, meeting: this.current.id }, "source evidence unavailable; using owned audio");
                    return null;
                })
            )
        );
        return this.evidenceOnce;
    }

    /** The evidence the rules may read: no speaking readings when the record's platform has no speaking indicator. */
    async evidence(): Promise<MeetingEvidence | null> {
        const evidence = speakingEvidence(this.current, await this.sourceEvidence());
        return evidence?.speaking.length
            ? { ...evidence, mutedCarrySec: (await this.config()).global.suggest.mutedCarrySec }
            : evidence;
    }

    /** The call on the transcript clock, with the source's second 0. */
    timeline(): Promise<CallTimeline> {
        this.timelineOnce ??= Promise.all([this.linked(), this.meeting()]).then(([linked, meeting]) =>
            CallTimeline.ofSource(this.current, linked, meeting)
        );
        return this.timelineOnce;
    }

    /**
     * Who was in the call, the user under their own name: the stays `spec` names (a platform or a platform's export
     * file) when given, else the ones the record keeps.
     */
    async presence(spec?: string, attendanceId?: string): Promise<Presence[] | undefined> {
        const selectedId = attendanceId?.trim();
        const refusal = attendanceIdRefusal(spec, attendanceId);

        if (refusal) {
            throw new Error(refusal);
        }

        if (spec) {
            const timeline = await this.timeline();
            const loaded = await this.loadAttendance(spec, selectedId);
            ui.dim(loaded.note);
            return this.departurePresence(timeline.named(loaded.presence));
        }

        const attendance = this.current.attendance;

        if (attendance) {
            const named = (await this.timeline()).named(attendance.people);
            const extra = rosterPresence(this.current, await this.transcriptEndSec()).filter(
                (stay) => !named.some((known) => known.name === stay.name)
            );
            return this.departurePresence([...named, ...extra]);
        }

        const duration = await this.transcriptEndSec();
        const roster = rosterPresence(this.current, duration);
        if (roster.length === 0) {
            return undefined;
        }
        const evidence = await this.evidence();
        const selfName = evidence?.selfName ?? this.current.participants.find((person) => person.self)?.name;
        if (!evidence || !selfName) {
            return roster;
        }
        const derive = await this.stayDerivation({ evidence, selfName, durationSec: duration });
        return derive(this.current).flatMap((person) => person.stays.map((stay) => presenceOf(person, stay, duration)));
    }

    /** Load the source before the record lock; derive against the participants and decisions held under it. */
    private async stayDerivation({
        evidence,
        selfName,
        durationSec,
    }: {
        evidence: MeetingEvidence;
        selfName: string;
        durationSec: number;
    }) {
        const meeting = await this.meeting();
        const energy = await this.energy();
        const silenceMinutes = (await this.config()).global.suggest.leaveSilenceMinutes;
        return (record: MeetingRecord) => {
            const roster = rosterPresence(record, durationSec, { rederiveLeaves: true });
            const lines = lineEvidence(meeting.transcript, evidence, roster, energy.share);
            const matchedVoices = matchedCallVoices(record, lines);
            const hints = speakerStats(meeting.transcript, { participants: meeting.speakers, presence: roster }).hints;
            const departures = identifiedDepartures({
                devices: this.roomDevices,
                record,
                hints,
                lines: lines.map((line) => (line.speakingUnknown ? { ...line, speaking: {} } : line)),
                selfName,
                presence: roster,
                speaking: evidence.speaking,
                matchedVoices,
                roomPeople: wholeMeetingRoomPeople(record.seats),
                ignoredIndicator: assessIndicator({ lines, selfName, roomPeople: wholeMeetingRoomPeople(record.seats) })
                    .ignored,
            });
            return personStays({
                record,
                durationSec,
                lines,
                speaking: evidence.speaking,
                matchedVoices,
                departures,
                silenceMinutes,
                callSilent: record.evidence?.channels?.callSilent,
            });
        };
    }

    /** Every reader sees the same independently identified goodbye boundary, without changing stored evidence. */
    private async departurePresence(presence: Presence[] | undefined): Promise<Presence[] | undefined> {
        if (!presence?.length) {
            return presence;
        }
        const meeting = await this.meeting();
        const hints = speakerStats(meeting.transcript, { participants: meeting.speakers, presence }).hints;
        if (
            !hints.some((hint) => hint.kind === "leave-then-continues") &&
            !meeting.transcript.some((line) => isLeavePhrase(line.text))
        ) {
            return presence;
        }
        const evidence = await this.evidence();
        const selfName = evidence?.selfName ?? this.current.participants.find((person) => person.self)?.name;
        if (!evidence || !selfName) {
            return presence;
        }
        const lines = lineEvidence(meeting.transcript, evidence, presence, (await this.energy()).share);
        const matchedVoices = matchedCallVoices(this.current, lines);
        const departures = identifiedDepartures({
            devices: this.roomDevices,
            record: this.current,
            hints,
            lines: lines.map((line) => (line.speakingUnknown ? { ...line, speaking: {} } : line)),
            selfName,
            presence,
            speaking: evidence.speaking,
            matchedVoices,
            roomPeople: wholeMeetingRoomPeople(this.current.seats),
            ignoredIndicator: assessIndicator({
                lines,
                selfName,
                roomPeople: wholeMeetingRoomPeople(this.current.seats),
            }).ignored,
        });
        return presence.map((stay) => {
            // A missing flag is legacy exact attendance (`Presence`): only a bound the platform did not record moves.
            if (stay.leftAtExact !== false) {
                return stay;
            }
            const departure = departures.find(
                (event) =>
                    event.name === stay.name &&
                    event.atSec >= stay.fromSec &&
                    event.atSec < stay.toSec &&
                    !speechAfter({
                        record: this.current,
                        name: stay.name,
                        after: event.atSec + 5,
                        lines,
                        speaking: evidence.speaking,
                        matchedVoices,
                    })
            );
            return departure ? { ...stay, toSec: departure.atSec } : stay;
        });
    }

    private async loadAttendance(spec: string, attendanceId?: string) {
        const key = `${spec}\0${attendanceId ?? ""}`;
        const known = this.attendanceOnce.get(key);

        if (known) {
            return known;
        }

        const loading = (async () => {
            const timeline = await this.timeline();
            const meeting = await this.meeting();
            return loadPresence(
                { ...timeline.target(), title: meeting.title },
                spec,
                this.current.platform,
                attendanceId === undefined ? undefined : { id: attendanceId }
            );
        })();
        this.attendanceOnce.set(key, loading);
        // A failed read is not kept: the next ask tries the platform again.
        loading.catch(() => this.attendanceOnce.delete(key));
        return loading;
    }

    /** Suggestion rules may proceed without unavailable platform attendance; malformed input still throws. */
    async suggestionPresence(options: {
        attendance?: string;
        attendanceId?: string;
        warnings: string[];
    }): Promise<Presence[] | undefined> {
        try {
            const presence = await this.presence(options.attendance, options.attendanceId);
            if (presence !== undefined && (options.attendance || this.current.attendance)) {
                await this.rememberAttendanceAttempt();
            }
            return presence;
        } catch (error) {
            if (!(error instanceof AttendanceUnavailableError)) {
                throw error;
            }

            log.warn({ error, meeting: this.current.id }, "attendance unavailable for suggestions");
            await this.rememberAttendanceAttempt(
                `attendance unavailable, so the suggestions skip the attendance rule: ${error.message}`
            );
            // The rows warn in the same sentence, so the window shows one; the full text stays the record's detail.
            options.warnings.push(attendanceSentence(this.current.platform));
            return undefined;
        }
    }

    /**
     * `detail`: the failure's full text for the record's history; nothing when the lookup succeeded. The history is a
     * note beside the result: a failed write is logged and never replaces the attendance result or its fallback.
     */
    private async rememberAttendanceAttempt(detail?: string): Promise<void> {
        try {
            const updated = await this.store.updateIf(
                this.current.id,
                {
                    command: detail ? "attendance-failed" : "attendance-recovered",
                    change: detail ?? "attendance lookup succeeded",
                },
                (record) => (detail ? attendanceDetail(record) !== detail : attendanceDetail(record) !== undefined)
            );
            if (updated) {
                this.current = updated;
            }
        } catch (err) {
            log.warn({ err, meeting: this.current.id }, "the attendance attempt could not be written to the history");
        }
    }

    /** The microphone's energy share per time range, with the calibration it was read with. Writes nothing. */
    energy(): Promise<MicEnergy> {
        const unmerged = this.unmergedSound();

        if (unmerged) {
            return Promise.reject(unmerged);
        }

        this.energyOnce ??= this.sourceEvidence().then(async (evidence) => {
            if (!evidence?.audioPath) {
                return {};
            }
            const { global } = await this.config();
            const { source } = await this.linked();
            return energyMicShareFor(this.store, this.current, evidence, {
                minSeparation: global.speakerLabels.channels.minSeparation,
                sourceLayout: source.sourceLayout,
            });
        });
        return this.energyOnce;
    }

    /** The stretches where the call's channel stayed silent (the call played through the room); E1 says nothing there. */
    async silentCallSpans(): Promise<SilentCallSpan[]> {
        const stored = this.current.evidence?.channels;
        const energy = await this.energy();
        if (energy.share && stored?.callSilent && stored.layout === energy.calibration?.layout) {
            return stored.callSilent;
        }

        return callSilentSpans(energy, energy.share ? await this.transcriptEndSec() : 0);
    }

    /** The meetings config, read once. */
    config(): Promise<MeetingsConfig> {
        this.configOnce ??= new MeetingsConfigStore().read().then((config) => {
            const warning = missingProjectWarning(this.current, config);
            if (warning) {
                ui.warn(warning);
            }
            return config;
        });
        return this.configOnce;
    }

    /** The dictionary for this meeting: global, then its project's level, then its own. */
    async dictionary(): Promise<ResolvedDictionary> {
        return resolveDictionary(await this.config(), {
            project: this.current.project,
            meeting: this.current.dictionary,
        });
    }

    /** The words the source was taught to spell. */
    async sourceWords(): Promise<DictionaryCandidate[]> {
        return (await this.linked()).source.dictionary();
    }

    /** The action items and decisions of the source's summary. */
    async summaryPoints(): Promise<SummaryPoint[]> {
        const meeting = await this.meeting();
        return meeting.summary ? summaryPoints(meeting.summary, (await this.config()).global.summary) : [];
    }

    /**
     * The word check over the transcript's words, or why there is none: `choice` for every language, else each
     * language's configured provider (`languages.<code>.wordCheck`). The caller disposes the check.
     */
    async wordCheck(choice?: WordCheckChoice): ReturnType<typeof wordCheckFor> {
        const selection = choice ?? configuredWordChecks(await this.config());
        return wordCheckFor(selection, (await this.meeting()).transcript);
    }

    /** The recording the source keeps on this Mac. Throws a message ready to print. */
    async audioPath(): Promise<string> {
        const unmerged = this.unmergedSound();

        if (unmerged) {
            throw unmerged;
        }

        const owned = recordSourceAudio(this.current);
        if (owned) {
            return owned.path;
        }
        const evidence = await this.sourceEvidence();

        if (!evidence?.audioPath) {
            throw new Error(`The source keeps no audio for ${this.current.id} on this Mac.`);
        }

        return evidence.audioPath;
    }

    /**
     * The file a span from `fromSec` to `toSec` is cut from: when the record's sound was put together from several
     * recordings (`meetings join`), the recording that holds the whole span, so a clip is that recording's own sound to
     * the sample; else (a span over the time between recordings, or one recording) the record's one file.
     */
    async audioAt(fromSec: number, toSec = fromSec): Promise<AudioSpan> {
        if (!recordSourceAudio(this.current)?.pieces) {
            return { path: await this.audioPath(), offsetMs: 0 };
        }

        // A recording holds the time from its second 0 to its end, and never past the next recording's second 0.
        const pieces = (await this.soundInputs()).source?.pieces ?? [];
        const holder = pieces.find((piece, index) => {
            const next = pieces[index + 1]?.zeroSec ?? Number.POSITIVE_INFINITY;
            return piece.zeroSec <= fromSec && toSec <= Math.min(piece.zeroSec + piece.durationSec, next);
        });
        return holder
            ? { path: holder.path, offsetMs: Math.round(holder.zeroSec * 1000) }
            : { path: await this.audioPath(), offsetMs: 0 };
    }

    /**
     * One recording of a joined record as it was before the join, for a file written then that names each recording
     * (a polished file): its own source meeting and clock, with the joined record's items, assignments, participants and
     * seats moved back onto that clock. `recordId` is the id the recording had. Undefined on a single recording or for
     * an id that is not one of its recordings.
     */
    recordingReading(recordId: string): PartReading | undefined {
        const parts = this.current.join?.parts ?? [];
        const index = parts.findIndex((one) => one.record === recordId);
        const part = parts[index];

        if (!part) {
            return undefined;
        }

        const opened = new OpenedMeeting(new JoinedPartStore(this.store), partRecord(this.current, part), undefined);
        opened.configOnce = this.config();
        const next = parts[index + 1];
        return this.readingOf({
            part,
            fromSec: part.offsetMs / 1000,
            untilSec: next ? next.offsetMs / 1000 : Number.POSITIVE_INFINITY,
            opened,
        });
    }

    private readingOf(view: JoinedPartView): PartReading {
        const offsetMs = view.part.offsetMs;
        // The items' line addresses count on the joined transcript; this part's own transcript starts at its first line.
        // A label the join gave this recording's lines reads as the recording's own label again.
        const ownLabels = Object.entries(view.part.speakerLabels ?? {});
        const back = {
            ...clockMove(-offsetMs, -(view.part.firstLine ?? 0)),
            labels: new Map(ownLabels.map(([own, joined]) => [joined, own])),
        };
        const inside = (sec: number | undefined) => sec !== undefined && sec >= view.fromSec && sec < view.untilSec;
        const where = (item: MeetingRecord["items"][number]) => ("fromSec" in item ? item.fromSec : item.atSec);
        const assignments = (this.current.speakers.assignments ?? []).filter((one) => inside(one.fromSec));
        const record: MeetingRecord = {
            ...view.opened.record,
            items: this.current.items.filter((item) => inside(where(item))).map((item) => movedValue(item, back)),
            speakers: {
                labels: partSpeakerNames(this.current.speakers.labels, ownLabels),
                ...(assignments.length > 0 ? { assignments: movedValue(assignments, back) } : {}),
            },
            participants: movedValue(this.current.participants, back),
            // The recording's own seats as they were; a join made before parts kept them reads the joined ones back.
            ...(view.part.seats
                ? { seats: view.part.seats }
                : this.current.seats
                  ? { seats: movedValue(this.current.seats, back) }
                  : {}),
        };
        const opened = new OpenedMeeting(view.opened.store, record, undefined);
        opened.configOnce = this.config();
        opened.linkedOnce = view.opened.linked();
        return {
            opened,
            offsetMs,
            toJoinedSec: (sec) => toJoinedSec(sec, offsetMs),
            toPartSec: (sec) => toPartSec(sec, offsetMs),
        };
    }

    /** The source probe and recorder rows used to construct this meeting's sound. */
    soundInputs(): Promise<SoundInputs> {
        const unmerged = this.unmergedSound();

        if (unmerged) {
            return Promise.reject(unmerged);
        }

        this.soundInputsOnce ??= readSoundInputs(this);
        return this.soundInputsOnce;
    }

    /** The meeting's sound: the source's channels and the recorder's tracks, each on the transcript clock. */
    sound(): Promise<MeetingSound> {
        this.soundOnce ??= loadMeetingSound(this);
        return this.soundOnce;
    }

    private async transcriptEndSec(): Promise<number> {
        const lines = new TranscriptLines((await this.meeting()).transcript);
        return lines.entries.reduce((end, _entry, index) => Math.max(end, lines.end(index) ?? 0), 0);
    }

    /**
     * Stores the channel layout and the silent call stretches as `evidence.channels` when they changed. Undefined when
     * the source keeps no audio or ffmpeg is missing.
     */
    async calibrate(): Promise<ChannelCalibration | undefined> {
        const measured = await this.measureCalibration();

        if (!measured) {
            return undefined;
        }

        this.current = await storeCalibration({ store: this.store, record: this.current, ...measured });
        return measured.calibration;
    }

    /** The channel layout and the silent call stretches of this recording, measured (its caches written), not stored. */
    private async measureCalibration(): Promise<
        { calibration: ChannelCalibration; callSilent: SilentCallSpan[] } | undefined
    > {
        const evidence = await this.sourceEvidence();

        if (evidence?.audioPath) {
            await channelEnergy(evidence.audioPath, join(this.store.folder(this.current.id), "evidence", "energy.bin"));
            this.energyOnce = undefined;
        }

        let energy = await this.energy();
        const calibration = energy.calibration;

        if (!calibration) {
            return undefined;
        }

        const source = await this.sourceEvidence();
        if (source?.audioPath) {
            await collectEcho({
                audioPath: source.audioPath,
                cachePath: join(this.store.folder(this.current.id), "evidence", "echo.json"),
                layout: calibration.layout,
            });
            // The residual share needs the echo cache just written: the silent spans read the energy as it is now.
            this.energyOnce = undefined;
            energy = await this.energy();
        }

        return { calibration, callSilent: callSilentSpans(energy, await this.transcriptEndSec()) };
    }

    /**
     * Collects what a linked recording can tell without being asked: the call platform (from the source), the
     * attendance and its sections (when the platform keeps them and the record has none), and the audio channel
     * layout. A step that fails is a note, never an error: the record stays as it was for that step.
     *
     * `attendance` is the run's explicit choice (`--attendance <spec> [--attendance-id <id>]`): the title lookup never
     * runs then. A choice of the record's own platform is loaded exactly (that chat) and kept; a file or another
     * platform is the run's alone, so nothing is collected for the record.
     */
    async collect(options: { attendance?: { spec: string; id?: string } } = {}): Promise<CollectOutcome> {
        const notes: CollectOutcome["notes"] = [];

        if (!this.sourceRef && !this.linkedOnce) {
            return { record: this.current, notes };
        }

        const named = platformOfSourceName((await this.sourceEvidence())?.platform);

        if (!this.current.platform && named) {
            this.current = await this.store.update(
                this.current.id,
                { command: "collect", change: `platform ${named.id}` },
                (next) => {
                    next.platform = named.id;
                }
            );
            notes.push({ ok: true, text: `platform: ${named.label}` });
        }

        const platform = this.current.platform ? MEETING_PLATFORMS[this.current.platform] : undefined;

        const chosen = options.attendance;
        const foreignChoice = chosen !== undefined && chosen.spec !== platform?.id;

        if (this.current.join && !this.current.attendance && platform && platform.capabilities.attendance !== "none") {
            notes.push({ ok: true, text: "attendance: not read for a meeting joined from several recordings" });
        } else if (!this.current.attendance && platform && platform.capabilities.attendance !== "none") {
            if (foreignChoice) {
                notes.push({
                    ok: true,
                    text: `attendance: this run reads ${chosen.spec}, so none is kept on the record`,
                });
            } else {
                try {
                    const timeline = await this.timeline();
                    const loaded = await this.loadAttendance(platform.id, chosen?.id?.trim() || undefined);
                    this.current = await timeline.store(this.store, loaded, platform.id);
                    notes.push({ ok: true, text: `${loaded.note}, ${this.current.sections?.length ?? 0} sections` });
                } catch (err) {
                    // The note below tells the user; the day log keeps the stack.
                    log.debug({ err, meeting: this.current.id, platform: platform.id }, "attendance not collected");
                    const detail = `attendance not collected: ${err instanceof Error ? err.message : String(err)}`;
                    await this.rememberAttendanceAttempt(detail);
                    notes.push({ ok: false, text: attendanceSentence(this.current.platform), detail });
                }
            }
        }

        const calibration = await this.calibrate();

        if (calibration) {
            const { layout, reason } = calibration;
            notes.push({ ok: layout !== "unknown", text: `audio channels: ${layout}${reason ? ` (${reason})` : ""}` });
        }

        try {
            const evidence = await this.evidence();
            const selfName = evidence?.selfName ?? this.current.participants.find((person) => person.self)?.name;
            if (evidence && selfName && this.current.participants.length) {
                const durationSec = await this.transcriptEndSec();
                const derive = await this.stayDerivation({ evidence, selfName, durationSec });
                let updated = false;
                this.current = await this.store.update(
                    this.current.id,
                    { command: "collect", change: "derive person stays from identified events" },
                    (next) => {
                        const derived = derive(next);
                        for (const [index, person] of next.participants.entries()) {
                            const stays = derived[index]?.stays;
                            if (stays?.length && !isDeepStrictEqual(stays, person.stays)) {
                                person.stays = stays;
                                updated = true;
                            }
                        }
                        if (!updated) {
                            return MEETING_UNCHANGED;
                        }
                    }
                );
                if (updated) {
                    notes.push({
                        ok: true,
                        text: "person stays: identified departures and observed silent call windows",
                    });
                }
            }
        } catch (err) {
            log.debug({ err, meeting: this.current.id }, "person stays not derived");
            notes.push({
                ok: false,
                text: "person stays not derived: " + (err instanceof Error ? err.message : String(err)),
            });
        }

        log.debug({ meeting: this.current.id, notes }, "collected");
        return { record: this.current, notes };
    }

    /** Collects and prints one line per note; a failure here never fails the command that asked for it. */
    async collectAndReport(): Promise<MeetingRecord> {
        try {
            const outcome = await this.collect();

            for (const note of outcome.notes) {
                note.ok ? ui.dim(`  ${note.text}`) : ui.warn(`  ${note.text}`);

                if (note.detail) {
                    ui.dim(`    ${note.detail}`);
                }
            }
        } catch (err) {
            log.warn({ err, meeting: this.current.id }, "collect failed");
            ui.warn(`  could not collect the call's facts: ${err instanceof Error ? err.message : String(err)}`);
        }

        return this.current;
    }

    /** Collects only when the record lacks the platform, the attendance or the channel layout. */
    async collectWhenIncomplete(): Promise<MeetingRecord> {
        const { platform, attendance, evidence } = this.current;
        return platform && attendance && evidence?.channels ? this.current : this.collectAndReport();
    }
}
