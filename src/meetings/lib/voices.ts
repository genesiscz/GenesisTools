import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { roomSeatNames, seatIntervalsFor } from "@genesiscz/utils/meetings/seats";
import type { VoiceProgress } from "@genesiscz/utils/meetings/voice";
import {
    addVoicePrint,
    readVoiceStore,
    removeVoicePrint,
    type VoicePrint,
} from "@genesiscz/utils/meetings/voice-store";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import { OpenedMeeting } from "./opened-meeting";
import {
    type MeetingSound,
    measureSoundClock,
    meetingSound,
    readSoundInputs,
    type Seat,
    type SoundSlice,
    type TrackKind,
} from "./sound";
import type { LinkedSource } from "./sources";
import { proposeSpeakerLabels } from "./speaker-labels";
import type { LineLabel } from "./speaker-labels/types";
import { embedSeatLines, voiceProgressForMeeting, voiceSignalForMeeting } from "./speaker-labels/voice";
import { runSuggest } from "./suggest-run";
import { correctTranscript } from "./transcript-corrections";

const { log } = logger.scoped("meetings-voices");

export interface VoicesAccess {
    store: MeetingStore;
    linkedSource?: (record: MeetingRecord) => LinkedSource | undefined;
    config?: () => Promise<MeetingsConfig>;
}

export interface VoiceSampleRow {
    sample: number;
    meeting: string;
    seat: Seat;
    track: TrackKind;
    fromSec: number;
    toSec: number;
    confirmedAt: string;
    words: string;
    available: boolean;
}

export interface VoicePersonRow {
    project: string;
    person: string;
    meetings: string[];
    samples: VoiceSampleRow[];
}

function openedOf(access: VoicesAccess, record: MeetingRecord): OpenedMeeting {
    return OpenedMeeting.of(access.store, record, access.linkedSource?.(record));
}

function recordOf(access: VoicesAccess, meeting: string): MeetingRecord {
    const record = access.store.resolve(meeting);

    if (!record) {
        throw new Error(`No meeting "${meeting}".`);
    }

    return record;
}

/** Clock measurement belongs to an explicit writer; a preview keeps it in memory. */
export async function voiceReadMeeting(opened: OpenedMeeting): Promise<OpenedMeeting> {
    const inputs = await readSoundInputs(opened);
    let sound = meetingSound(inputs);

    if (!inputs.clock && inputs.tracks === "best" && sound.tracks.some((track) => track.clock === "stamp")) {
        const measured = await measureSoundClock(inputs);

        if (measured) {
            sound = meetingSound({ ...inputs, clock: measured.clock });
        }
    }

    // The base labeler measures and saves a stamp it sees. Its slice still refuses an unmeasured recorder track.
    const readOnly: MeetingSound = {
        tracks: sound.tracks.filter((track) => track.clock !== "stamp"),
        slice: sound.slice,
    };
    opened.sound = async () => readOnly;
    return opened;
}

export async function listProjectVoices(
    options: VoicesAccess & { project?: string }
): Promise<{ people: VoicePersonRow[] }> {
    const records = options.store.list();
    const folder = toolDataDir("meetings", "voices");
    const projects = options.project
        ? [options.project]
        : [
              ...new Set([
                  ...records.flatMap((record) => (record.project ? [record.project] : [])),
                  ...(existsSync(folder)
                      ? readdirSync(folder)
                            .filter((file) => file.endsWith(".json"))
                            .map((file) => file.slice(0, -5))
                      : []),
              ]),
          ].sort();
    const people: VoicePersonRow[] = [];
    const openedMeetings = new Map<string, OpenedMeeting>();

    for (const project of projects) {
        const voiceStore = readVoiceStore(project);
        const meetings = records.filter((record) => record.project === project);
        const names = new Set([
            ...Object.keys(voiceStore.people),
            ...meetings.flatMap((record) => [
                ...record.participants.map((person) => person.name),
                ...roomSeatNames(record.seats),
                ...(record.seats?.remote.map((person) => person.name) ?? []),
            ]),
        ]);

        for (const person of [...names].sort()) {
            const samples: VoiceSampleRow[] = [];

            for (const [index, sample] of (voiceStore.people[person]?.samples ?? []).entries()) {
                let words = "";
                let available = false;
                const record = options.store.read(sample.meeting);

                if (record) {
                    try {
                        let opened = openedMeetings.get(record.id);
                        if (!opened) {
                            opened = openedOf(options, record);
                            openedMeetings.set(record.id, opened);
                        }
                        const lines = new TranscriptLines((await opened.meeting()).transcript);
                        words = lines.entries
                            .filter((_entry, at) => {
                                const span = lines.span(at);
                                return span && span.fromSec < sample.toSec && span.toSec > sample.fromSec;
                            })
                            .map((entry) => entry.text)
                            .join(" ");
                        available = !!(await opened.sound()).slice({ ...sample, purpose: "listen" });
                    } catch (error) {
                        log.debug({ error, meeting: sample.meeting }, "voice sample source unavailable");
                    }
                }

                const { embedding: _embedding, sourceSha: _sha, question: _question, ...shown } = sample;
                samples.push({ ...shown, sample: index + 1, words, available });
            }

            people.push({
                project,
                person,
                samples,
                meetings: [
                    ...new Set([
                        ...samples.map((sample) => sample.meeting),
                        ...meetings
                            .filter(
                                (record) =>
                                    record.participants.some((entry) => sameName(entry.name, person)) ||
                                    roomSeatNames(record.seats).some((name) => sameName(name, person)) ||
                                    record.seats?.remote.some((entry) => sameName(entry.name, person))
                            )
                            .map((record) => record.id),
                    ]),
                ],
            });
        }
    }

    return { people };
}

export async function previewVoices(
    options: VoicesAccess & { meeting: string; onProgress?: VoiceProgress; signal?: AbortSignal }
): Promise<{
    meeting: string;
    project?: string;
    lines: Array<LineLabel & { fromSec: number; toSec: number; text: string; current: string }>;
}> {
    const record = recordOf(options, options.meeting);
    const opened = await voiceReadMeeting(openedOf(options, record));
    if (options.onProgress) {
        voiceProgressForMeeting.set(opened, options.onProgress);
    }

    if (options.signal) {
        voiceSignalForMeeting.set(opened, options.signal);
    }

    const config = await (options.config?.() ?? opened.config());
    const meeting = await opened.meeting();
    const lines = new TranscriptLines(meeting.transcript);
    const corrected = correctTranscript({
        record,
        transcript: meeting.transcript,
        config,
        format: "json",
        withSuggested: true,
    });
    const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels, undefined, {
        voiceOnly: true,
        applyAbove: config.global.suggest.applyAbove,
    });
    return {
        meeting: record.id,
        ...(record.project ? { project: record.project } : {}),
        lines: labels
            .filter((label) => label.labeler === "voice")
            .flatMap((label) => {
                const span = lines.span(label.index);
                const entry = meeting.transcript[label.index];
                return span && entry
                    ? [
                          {
                              ...label,
                              ...span,
                              text: entry.text,
                              current:
                                  corrected.entries.find(
                                      (current) =>
                                          current.sourceIndex === label.index ||
                                          (entry.id !== undefined && current.id === entry.id) ||
                                          (entry.startSec !== undefined && current.startSec === entry.startSec)
                                  )?.speaker ?? entry.speaker,
                          },
                      ]
                    : [];
            }),
    };
}

export async function applyVoices(
    options: VoicesAccess & { meeting: string; onProgress?: VoiceProgress; signal?: AbortSignal }
): Promise<{ meeting: string; added: number; warnings: string[] }> {
    const record = recordOf(options, options.meeting);

    if (!record.project) {
        throw new Error("Choose a project before naming voices.");
    }

    const result = await runSuggest({
        store: options.store,
        record,
        rules: ["speakers"],
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
    });
    return { meeting: record.id, added: result.fresh.length, warnings: result.warnings };
}

function selectedSample(options: { project: string; person: string; sample?: number }): VoicePrint {
    const samples = readVoiceStore(options.project).people[options.person]?.samples ?? [];
    const index = options.sample ?? 1;

    if (!Number.isInteger(index) || index < 1 || !samples[index - 1]) {
        throw new Error(`No voice sample ${index} for this person in this project.`);
    }

    return samples[index - 1]!;
}

export async function voiceSample(
    options: VoicesAccess & { project: string; person: string; sample?: number }
): Promise<SoundSlice & { meeting: string; fromSec: number; toSec: number }> {
    const sample = selectedSample(options);
    const record = recordOf(options, sample.meeting);
    const sound = await openedOf(options, record).sound();
    const slice = sound.slice({ ...sample, purpose: "listen" });

    if (!slice) {
        throw new Error("This sample's track has no audible sound covering its time.");
    }

    const hash = createHash("sha256");
    for await (const chunk of createReadStream(slice.path)) {
        hash.update(chunk);
    }

    if (hash.digest("hex") !== sample.sourceSha) {
        throw new Error("This sample's sound changed since it was confirmed; confirm a new sample.");
    }

    return { ...slice, meeting: record.id, fromSec: sample.fromSec, toSec: sample.toSec };
}

export function planVoiceRemoval(options: VoicesAccess & { project: string; person: string; sample?: number }) {
    const samples = readVoiceStore(options.project).people[options.person]?.samples ?? [];

    if (options.sample !== undefined) {
        selectedSample(options);
    }

    return {
        project: options.project,
        person: options.person,
        removed: options.sample === undefined ? samples.length : 1,
        affected: options.store
            .list()
            .filter((record) => record.project === options.project)
            .flatMap((record) =>
                record.items.flatMap((item) =>
                    item.kind === "speaker-range" &&
                    item.status === "suggested" &&
                    item.rules.includes(MeetingRule.VoiceEmbedding) &&
                    item.speaker &&
                    sameName(item.speaker, options.person)
                        ? [{ meeting: record.id, item: item.id, fromSec: item.fromSec, toSec: item.toSec }]
                        : []
                )
            ),
    };
}

export async function removeVoice(options: VoicesAccess & { project: string; person: string; sample?: number }) {
    const plan = planVoiceRemoval(options);
    // Remove stale names first: an interrupted removal can leave a print, never a name based on a removed print.
    for (const meeting of new Set(plan.affected.map((row) => row.meeting))) {
        await options.store.update(
            meeting,
            { command: "voices remove", change: "retire voice suggestions after sample removal" },
            (record) => {
                const planned = new Set(plan.affected.filter((row) => row.meeting === meeting).map((row) => row.item));
                const ids = new Set(
                    record.items
                        .filter(
                            (item) =>
                                planned.has(item.id) &&
                                item.kind === "speaker-range" &&
                                item.status === "suggested" &&
                                item.rules.includes(MeetingRule.VoiceEmbedding) &&
                                item.speaker &&
                                sameName(item.speaker, options.person)
                        )
                        .map((item) => item.id)
                );
                record.items = record.items.filter((item) => !ids.has(item.id));
                for (const item of record.items) {
                    if (item.kind === "question" && item.decides) {
                        item.decides = item.decides.filter((id) => !ids.has(id));
                    }
                }
            }
        );
    }

    if (options.sample === undefined) {
        removeVoicePrint(options.project, options.person);
    } else {
        const selected = selectedSample(options);
        const store = readVoiceStore(options.project);
        const siblings = store.people[options.person]!.samples.filter(
            (sample) =>
                sample !== selected && sample.meeting === selected.meeting && sample.fromSec === selected.fromSec
        );
        removeVoicePrint(options.project, options.person, selected);
        for (const sibling of siblings) {
            if (
                sibling.track !== selected.track ||
                sibling.sourceSha !== selected.sourceSha ||
                sibling.toSec !== selected.toSec
            ) {
                addVoicePrint(options.project, options.person, sibling, store.model);
            }
        }
    }

    return plan;
}

export async function addVoiceSample(
    options: VoicesAccess & { meeting: string; fromSec: number; toSec: number; person: string; confirmed: boolean }
): Promise<{ samples: number }> {
    if (
        !options.confirmed ||
        !Number.isFinite(options.fromSec) ||
        !Number.isFinite(options.toSec) ||
        options.fromSec < 0 ||
        options.toSec <= options.fromSec
    ) {
        throw new Error("Give a valid --from/--to interval and --confirmed after listening to this person.");
    }

    const record = recordOf(options, options.meeting);
    if (!record.project) {
        throw new Error("Choose a project before adding a voice sample.");
    }

    const opened = await voiceReadMeeting(openedOf(options, record));
    const lines = new TranscriptLines((await opened.meeting()).transcript);
    const energy = await opened.energy();
    const evidence = await opened.evidence();
    const { lineEvidence } = await import("@genesiscz/utils/transcribe/evidence");
    const stays = (await opened.presence())?.filter((stay) => sameName(stay.name, options.person)) ?? [];
    const seated = record.seats && seatIntervalsFor(record.seats, options.person);
    const hasSavedSeat = Boolean(
        seated?.length || record.seats?.remote.some((row) => sameName(row.name, options.person))
    );
    const self = record.participants.some((person) => person.self && sameName(person.name, options.person));
    const eligible = lineEvidence(
        [...lines.entries],
        evidence ?? { segments: [], speaking: [] },
        undefined,
        energy.share
    ).flatMap((line) => {
        const share = line.micShare ?? line.energyMic;
        if (share === undefined || share === 0.5 || line.startSec < options.fromSec || line.endSec > options.toSec) {
            return [];
        }
        const seat: Seat = share > 0.5 ? "mic" : "call";
        const present = stays.some((stay) => stay.fromSec <= line.startSec && line.endSec <= stay.toSec);
        const eligibleSeat = hasSavedSeat
            ? seated?.some(
                  (span) =>
                      span.side === seat && span.fromSec <= line.startSec && line.endSec <= (span.toSec ?? Infinity)
              ) &&
              (seat === "mic" || present)
            : record.seats && present && (self ? "mic" : "call") === seat;
        return eligibleSeat ? [{ index: line.index, fromSec: line.startSec, toSec: line.endSec, seat }] : [];
    });
    const embedded = await embedSeatLines({ lines: eligible, sound: await opened.sound() });
    let samples = 0;
    for (const line of embedded) {
        const voice = line.channels[0];
        if (voice?.quality !== "ready") {
            continue;
        }
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(voice.source.audioPath)) {
            hash.update(chunk);
        }
        addVoicePrint(
            record.project,
            options.person,
            {
                meeting: record.id,
                sourceSha: hash.digest("hex"),
                seat: line.seat,
                track: line.track,
                fromSec: line.fromSec!,
                toSec: line.toSec!,
                embedding: voice.embedding,
                confirmedAt: new Date().toISOString(),
            },
            voice.model
        );
        samples++;
    }
    if (!samples) {
        throw new Error("No complete usable line of this person's seat in that interval; no sample was saved.");
    }
    return { samples };
}
