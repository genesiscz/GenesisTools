import { join } from "node:path";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingsConfig, MeetingsConfigStore, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { type ChannelCalibration, channelEnergy, type SilentCallSpan } from "@genesiscz/utils/meetings/energy";
import { AttendanceUnavailableError } from "@genesiscz/utils/meetings/platform";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { DictionaryCandidate, MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { ResolvedDictionary } from "@genesiscz/utils/transcribe/dictionary";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";
import { speakerStats } from "@genesiscz/utils/transcribe/speakers";
import { type SummaryPoint, summaryPoints } from "@genesiscz/utils/transcribe/summary";
import { loadPresence } from "./attendance";
import { CallTimeline } from "./call-timeline";
import { identifiedDepartures } from "./departure";
import { callSilentSpans, energyMicShareFor, type MicEnergy, storeCalibration } from "./energy";
import { personStays, rosterPresence } from "./person-stays";
import { MEETING_PLATFORMS, platformOfSourceName, speakingEvidence } from "./platforms";
import { missingProjectWarning } from "./project";
import { preservedSourceAudio, withPreservedSourceAudio } from "./source-audio";
import { type LinkedSource, linkedSource, type SourceRef, sourceRefOf } from "./sources";
import { assessIndicator } from "./speaker-indicator";
import { configuredWordChecks, type WordCheckChoice, wordCheckFor } from "./word-check";

const { log } = logger.scoped("meetings-opened");

export interface CollectOutcome {
    record: MeetingRecord;
    /** One line per step that did something or could not, for the user. */
    notes: Array<{ ok: boolean; text: string }>;
}

/**
 * One meeting, opened once: its record and, read lazily and once, the linked source's meeting, the evidence (filtered
 * by the platform), the call timeline with presence, the calibrated energy share, the silent call stretches, the
 * dictionary, the summary points and the word check. Reading never writes the record: collecting the call's facts and
 * storing the channel calibration are the explicit steps `collect` and `calibrate`.
 */
export class OpenedMeeting {
    private current: MeetingRecord;
    private linkedOnce?: Promise<LinkedSource>;
    private meetingOnce?: Promise<SourceMeeting>;
    private evidenceOnce?: Promise<MeetingEvidence | null>;
    private energyOnce?: Promise<MicEnergy>;
    private timelineOnce?: Promise<CallTimeline>;
    private configOnce?: Promise<MeetingsConfig>;

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
    static of(store: MeetingStore, record: MeetingRecord, linked?: LinkedSource): OpenedMeeting {
        return new OpenedMeeting(store, record, linked);
    }

    /** The record as the last explicit step left it. */
    get record(): MeetingRecord {
        return this.current;
    }

    /** The linked source meeting, without loading the source; undefined when no source names one. */
    get sourceRef(): SourceRef | undefined {
        return sourceRefOf(this.current);
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
                    if (!preservedSourceAudio(this.current)) {
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
        return speakingEvidence(this.current, await this.sourceEvidence());
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

        if (selectedId !== undefined && (!spec || selectedId.length === 0)) {
            throw new Error("--attendance-id requires --attendance <platform> and a nonempty id.");
        }

        if (spec) {
            const timeline = await this.timeline();
            const loaded = await this.loadAttendance(spec, selectedId);
            ui.dim(loaded.note);
            return timeline.named(loaded.presence);
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
        const meeting = await this.meeting();
        const evidence = await this.evidence();
        const selfName = this.current.participants.find((person) => person.self)?.name;
        if (!evidence || !selfName) {
            return roster;
        }
        const energy = await this.energy();
        const lines = lineEvidence(meeting.transcript, evidence, roster).map((line) => ({
            ...line,
            energyMic: energy.share?.(line.startSec, line.endSec),
        }));
        const hints = speakerStats(meeting.transcript, { participants: meeting.speakers, presence: roster }).hints;
        const departures = identifiedDepartures({
            hints,
            lines: lines.map((line) => (line.speakingUnknown ? { ...line, speaking: {} } : line)),
            selfName,
            presence: roster,
            ignoredIndicator: assessIndicator({ lines, selfName }).ignored,
        });
        return personStays({
            record: this.current,
            durationSec: duration,
            lines,
            departures,
            silenceMinutes: (await this.config()).global.suggest.leaveSilenceMinutes,
            callSilent: this.current.evidence?.channels?.callSilent,
        }).flatMap((person) =>
            person.stays.map((stay) => ({
                name: person.name,
                self: person.self,
                fromSec: stay.fromSec,
                toSec: stay.toSec ?? duration,
            }))
        );
    }

    /** Every reader sees the same independently identified goodbye boundary, without changing stored evidence. */
    private async departurePresence(presence: Presence[] | undefined): Promise<Presence[] | undefined> {
        if (!presence?.length) {
            return presence;
        }
        const meeting = await this.meeting();
        const hints = speakerStats(meeting.transcript, { participants: meeting.speakers, presence }).hints;
        if (!hints.some((hint) => hint.kind === "leave-then-continues")) {
            return presence;
        }
        const evidence = await this.evidence();
        const selfName = evidence?.selfName ?? this.current.participants.find((person) => person.self)?.name;
        if (!evidence || !selfName) {
            return presence;
        }
        const lines = lineEvidence(meeting.transcript, evidence, presence, (await this.energy()).share);
        const departures = identifiedDepartures({
            hints,
            lines,
            selfName,
            presence,
            ignoredIndicator: assessIndicator({ lines, selfName }).ignored,
        });
        return presence.map((stay) => {
            if (stay.leftAtExact === true) {
                return stay;
            }
            const departure = departures.find(
                (event) => event.name === stay.name && event.atSec >= stay.fromSec && event.atSec < stay.toSec
            );
            return departure ? { ...stay, toSec: departure.atSec } : stay;
        });
    }

    private async loadAttendance(spec: string, attendanceId?: string) {
        const timeline = await this.timeline();
        const meeting = await this.meeting();
        return loadPresence(
            { ...timeline.target(), title: meeting.title },
            spec,
            this.current.platform,
            attendanceId === undefined ? undefined : { id: attendanceId }
        );
    }

    /** Suggestion rules may proceed without unavailable platform attendance; malformed input still throws. */
    async suggestionPresence(options: {
        attendance?: string;
        attendanceId?: string;
        warnings: string[];
    }): Promise<Presence[] | undefined> {
        try {
            return await this.presence(options.attendance, options.attendanceId);
        } catch (error) {
            if (!(error instanceof AttendanceUnavailableError)) {
                throw error;
            }

            log.warn({ error, meeting: this.current.id }, "attendance unavailable for suggestions");
            options.warnings.push(`attendance unavailable; E2 skipped: ${error.message}`);
            return undefined;
        }
    }

    /** The microphone's energy share per time range, with the calibration it was read with. Writes nothing. */
    energy(): Promise<MicEnergy> {
        this.energyOnce ??= this.sourceEvidence().then((evidence) =>
            energyMicShareFor(this.store, this.current, evidence)
        );
        return this.energyOnce;
    }

    /** The stretches where the call's channel stayed silent (the call played through the room); E1 says nothing there. */
    async silentCallSpans(): Promise<SilentCallSpan[]> {
        const stored = this.current.evidence?.channels?.callSilent;

        if (stored) {
            return stored;
        }

        return callSilentSpans(await this.energy(), await this.transcriptEndSec());
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
        const owned = preservedSourceAudio(this.current);
        if (owned) {
            return owned.path;
        }
        const evidence = await this.sourceEvidence();

        if (!evidence?.audioPath) {
            throw new Error(`The source keeps no audio for ${this.current.id} on this Mac.`);
        }

        return evidence.audioPath;
    }

    private async transcriptEndSec(): Promise<number> {
        const lines = new TranscriptLines((await this.meeting()).transcript);
        return lines.entries.reduce((end, _entry, index) => Math.max(end, lines.end(index) ?? 0), 0);
    }

    /**
     * Stores the channel layout and the silent call stretches as `evidence.channels` when they changed. Undefined
     * when the source keeps no audio or ffmpeg is missing.
     */
    async calibrate(): Promise<ChannelCalibration | undefined> {
        const evidence = await this.sourceEvidence();

        if (evidence?.audioPath) {
            await channelEnergy(evidence.audioPath, join(this.store.folder(this.current.id), "evidence", "energy.bin"));
            this.energyOnce = undefined;
        }

        const energy = await this.energy();

        if (!energy.calibration) {
            return undefined;
        }

        this.current = await storeCalibration({
            store: this.store,
            record: this.current,
            calibration: energy.calibration,
            callSilent: callSilentSpans(energy, await this.transcriptEndSec()),
        });
        return energy.calibration;
    }

    /**
     * Collects what a linked recording can tell without being asked: the call platform (from the source), the
     * attendance and its sections (when the platform keeps them and the record has none), and the audio channel
     * layout. A step that fails is a note, never an error: the record stays as it was for that step.
     */
    async collect(): Promise<CollectOutcome> {
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

        if (!this.current.attendance && platform && platform.capabilities.attendance !== "none") {
            try {
                const timeline = await this.timeline();
                const loaded = await this.loadAttendance(platform.id);
                this.current = await timeline.store(this.store, loaded, platform.id);
                notes.push({ ok: true, text: `${loaded.note}, ${this.current.sections?.length ?? 0} sections` });
            } catch (err) {
                // The note below tells the user; the day log keeps the stack.
                log.debug({ err, meeting: this.current.id, platform: platform.id }, "attendance not collected");
                notes.push({
                    ok: false,
                    text: `attendance not collected: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        }

        const calibration = await this.calibrate();

        if (calibration) {
            const { layout, reason } = calibration;
            notes.push({ ok: layout !== "unknown", text: `audio channels: ${layout}${reason ? ` (${reason})` : ""}` });
        }

        try {
            const meeting = await this.meeting();
            const evidence = await this.evidence();
            const selfName = this.current.participants.find((person) => person.self)?.name;
            if (evidence && selfName && this.current.participants.length) {
                const durationSec = await this.transcriptEndSec();
                const presence = rosterPresence(this.current, durationSec);
                const energy = await this.energy();
                const lines = lineEvidence(meeting.transcript, evidence, presence).map((line) => ({
                    ...line,
                    energyMic: energy.share?.(line.startSec, line.endSec),
                }));
                const hints = speakerStats(meeting.transcript, { participants: meeting.speakers, presence }).hints;
                const departures = identifiedDepartures({
                    hints,
                    lines: lines.map((line) => (line.speakingUnknown ? { ...line, speaking: {} } : line)),
                    selfName,
                    presence,
                    ignoredIndicator: assessIndicator({ lines, selfName }).ignored,
                });
                const derived = personStays({
                    record: this.current,
                    durationSec,
                    lines,
                    departures,
                    silenceMinutes: (await this.config()).global.suggest.leaveSilenceMinutes,
                    callSilent: this.current.evidence?.channels?.callSilent,
                });
                const participants = this.current.participants.map((person) => {
                    const stays = derived.find((one) => one.name === person.name)?.stays;
                    return stays?.length ? { ...person, stays } : person;
                });
                if (SafeJSON.stringify(participants) !== SafeJSON.stringify(this.current.participants)) {
                    this.current = await this.store.update(
                        this.current.id,
                        { command: "collect", change: "derive person stays from identified events" },
                        (next) => {
                            next.participants = participants;
                        }
                    );
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
