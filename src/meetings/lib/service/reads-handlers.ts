import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { channelEnergy, ENERGY_BLOCKS_PER_SEC } from "@genesiscz/utils/meetings/energy";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { activeSeatPeople } from "@genesiscz/utils/meetings/seats";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { DEFAULT_SPAN_GAP_SEC, sameName } from "@genesiscz/utils/transcribe/speakers";
import {
    configValueAt,
    missingMapKey,
    parseConfigPath,
    setConfigValue,
    unknownConfigPath,
    unsetConfigValue,
} from "../config-edit";
import { DecisionJournal } from "../decision-journal";
import { type DecidedLine, decidedLines, itemLines, personPresent } from "../listen-answers";
import { localSpeechDuring } from "../local-speech";
import { attendanceDetail, attendanceWarning, OpenedMeeting } from "../opened-meeting";
import { compactEvidence, rawMeeting } from "../raw";
import { screenTimeline } from "../screen-timeline";
import { configShowRead, overviewRead, rowsRead, speakerStatsRead } from "../window-reads";
import type { MeetingsParsedParams, MeetingsResult } from "./api";
import { type MeetingsHandlerDeps, recordOf, refusal } from "./handlers";

/**
 * The Meetings service's reads for the timeline and the settings (`meeting.speakers`, `meeting.screen`,
 * `meeting.waveform`, `meetings.overview`, `config.*`). Loaded by handlers.ts only when a call asks for one of them.
 */

interface SwapSkip {
    id: string;
    /** The labels a skip applies to; absent when the swap names no label, so every label at that time matches. */
    labels?: unknown[];
}

/** Every open swap item's skipped line starts, indexed once so each transcript line is one lookup. */
function swapSkipIndex(record: MeetingRecord): Map<number, SwapSkip[]> {
    const index = new Map<number, SwapSkip[]>();
    for (const item of record.items) {
        const swap = item.evidence?.swap;
        if (
            item.kind !== "speaker-range" ||
            item.status === "rejected" ||
            typeof swap !== "object" ||
            swap === null ||
            !("skipped" in swap) ||
            !Array.isArray(swap.skipped)
        ) {
            continue;
        }

        const labels =
            "selfLabel" in swap ? [swap.selfLabel, ...("otherLabel" in swap ? [swap.otherLabel] : [])] : undefined;
        for (const startSec of new Set(swap.skipped)) {
            if (typeof startSec !== "number") {
                continue;
            }

            const skips = index.get(startSec) ?? [];
            skips.push({ id: item.id, ...(labels ? { labels } : {}) });
            index.set(startSec, skips);
        }
    }

    return index;
}

export async function readRows(
    params: MeetingsParsedParams<"meeting.rows">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<
    MeetingsResult<"meeting.rows"> & {
        questionDetails?: QuestionDetails[];
        lineEvidence?: WindowLineEvidence[];
        attendanceWarning?: string;
        attendanceDetail?: string;
    }
> {
    const record = recordOf(store, params.meeting);
    const linked = deps.linkedSource?.(record);
    const config = await (deps.config?.() ?? (deps.configStore?.() ?? new MeetingsConfigStore()).read());
    const warning = attendanceWarning(record);
    const detail = attendanceDetail(record);
    const opened = OpenedMeeting.of(store, record, linked);
    const result = {
        ...(await rowsRead({
            store,
            record,
            opened,
            minPriority: config.global.playback.listen.minPriority,
            ...(params.lowPriority ? { lowPriority: params.lowPriority } : {}),
            applyAbove: params.applyAbove ?? config.global.suggest.applyAbove,
        })),
        ...(warning ? { attendanceWarning: warning } : {}),
        ...(detail ? { attendanceDetail: detail } : {}),
    };
    const transcript = await opened.meeting().catch((error: unknown) => {
        logger.debug({ error, meeting: record.id }, "question line data needs a readable transcript");
        return undefined;
    });

    if (!transcript) {
        return result;
    }

    const lines = new TranscriptLines(transcript.transcript);
    const questions = record.items.filter((item) => item.kind === "question");
    const decidedById = new Map(
        questions.map((question) => [question.id, decidedLines({ record, question, transcript: lines })])
    );
    const doubtKey = (question: (typeof questions)[number]) => {
        if (question.about === "speaker" && question.signature) {
            return SafeJSON.stringify([question.about, question.signature, question.evidence?.labels]);
        }
        if (question.about !== "speaker" && question.heard) {
            return SafeJSON.stringify([question.about, question.heard.toLocaleLowerCase(), question.choices]);
        }
        return question.id;
    };
    const doubts = new Map<string, Set<number>>();
    for (const question of questions.filter((one) => one.status === "suggested")) {
        const key = doubtKey(question);
        const indexes = doubts.get(key) ?? new Set<number>();
        for (const line of decidedById.get(question.id) ?? []) {
            indexes.add(line.index);
        }
        doubts.set(key, indexes);
    }
    const asked = new Set(questions.flatMap((question) => question.decides));
    for (const item of record.items) {
        if (
            item.kind !== "speaker-range" ||
            item.status !== "suggested" ||
            asked.has(item.id) ||
            typeof item.evidence?.signature !== "string"
        ) {
            continue;
        }
        const key = SafeJSON.stringify(["speaker", item.evidence.signature, [item.label]]);
        const indexes = doubts.get(key) ?? new Set<number>();
        for (const line of itemLines(item, lines)) {
            indexes.add(line.index);
        }
        doubts.set(key, indexes);
    }
    const entries = new Map(new DecisionJournal({ store }).read(record.id).map((entry) => [entry.token, entry]));
    const questionsById = new Map(questions.map((question) => [question.id, question]));
    const questionDetails = result.rows.flatMap((row): QuestionDetails[] => {
        const question = questionsById.get(row.id);
        if (!question) {
            return [];
        }

        const decided = decidedById.get(question.id) ?? [];
        const sameDoubt = doubts.get(doubtKey(question));
        const decidedElsewhere = new Set(decided.map((line) => line.index).filter((index) => !sameDoubt?.has(index)));
        const entry = question.decision && entries.get(question.decision.token);
        const raised =
            entry?.action.kind === "answer" && entry.question === question.id && !entry.revertedBy
                ? entry.changes.flatMap((change) => {
                      const after = change.after;
                      return after &&
                          !question.decides.includes(after.id) &&
                          after.id !== question.id &&
                          after.confidence !== undefined &&
                          after.confidence > (change.before?.confidence ?? 0)
                          ? after.kind === "question"
                              ? decidedLines({ record, question: after, transcript: lines })
                              : itemLines(after, lines)
                          : [];
                  })
                : [];
        return [
            {
                id: row.id,
                decidedLines: decided,
                impact: {
                    lines: decided.length,
                    words: decided.reduce((total, line) => total + line.text.trim().split(/\s+/u).length, 0),
                    sameDoubtLines: (sameDoubt?.size ?? 0) + decidedElsewhere.size,
                },
                ...(entry?.action.kind === "answer"
                    ? {
                          raisedLines: [...new Map(raised.map((line) => [line.index, line])).values()].sort(
                              (a, b) => a.index - b.index
                          ),
                      }
                    : {}),
            },
        ];
    });
    // Each measurement is optional on its own: a failed energy read keeps the evidence and presence that did load.
    const optional = <T>(name: string, read: Promise<T>) =>
        read.catch((error: unknown) => {
            logger.debug(
                { error, meeting: record.id, measurement: name },
                "a line measurement is unavailable for review rows"
            );
            return undefined;
        });
    const [evidence, energy, presence] = await Promise.all([
        optional("evidence", opened.evidence()),
        optional("energy", opened.energy()),
        optional("presence", opened.presence()),
    ]);
    const owners = [
        ...record.participants.filter((person) => person.self).map((person) => person.name),
        ...(evidence?.selfName ? [evidence.selfName] : []),
    ];
    const remoteKnown =
        record.attendance !== undefined ||
        record.seats !== undefined ||
        record.participants.some((person) => !person.self && person.stays !== undefined);
    const swapSkips = swapSkipIndex(record);
    const perLine = lineEvidence(
        transcript.transcript,
        evidence ?? { segments: [], speaking: [] },
        presence,
        energy?.share
    ).map((line): WindowLineEvidence => {
        const skipped = (swapSkips.get(line.startSec) ?? [])
            .filter((skip) => skip.labels === undefined || skip.labels.includes(line.label))
            .map((skip) => skip.id);
        const active = record.seats && activeSeatPeople({ seats: record.seats, atSec: line.startSec });
        const atMic = [...owners, ...(active?.room ?? [])];
        const remotePresent = active
            ? active.remote.some((person) => personPresent(record, person.name, line.startSec))
            : presence?.some(
                  (person) =>
                      !person.self &&
                      !atMic.some((name) => sameName(name, person.name)) &&
                      line.startSec >= person.fromSec &&
                      line.startSec < person.toSec
              );
        const microphone = line.energyMic ?? line.micShare;
        const noRemote =
            remoteKnown &&
            remotePresent === false &&
            (microphone === undefined || microphone < 0.5) &&
            !atMic.some((name) => sameName(name, line.label));
        return {
            index: line.index,
            startSec: line.startSec,
            endSec: line.endSec,
            ...(skipped.length ? { swapSkippedBy: skipped } : {}),
            ...(noRemote ? { noRemotePresent: true } : {}),
            ...(microphone === undefined ? {} : { micShare: microphone }),
            ...(line.acoustic
                ? {
                      callRms: line.acoustic.callRms,
                      echoOfCall: line.acoustic.echoOfCall,
                      acousticQuality: line.acoustic.quality,
                  }
                : {}),
        };
    });
    const measured = perLine.some(
        (line) =>
            line.swapSkippedBy !== undefined ||
            line.noRemotePresent !== undefined ||
            line.micShare !== undefined ||
            line.callRms !== undefined ||
            line.echoOfCall !== undefined
    );
    return {
        ...result,
        ...(questionDetails.length ? { questionDetails } : {}),
        ...(measured ? { lineEvidence: perLine } : {}),
    };
}

interface QuestionDetails {
    id: string;
    decidedLines: DecidedLine[];
    impact: { lines: number; words: number; sameDoubtLines: number };
    raisedLines?: DecidedLine[];
}

interface WindowLineEvidence {
    index: number;
    startSec: number;
    endSec: number;
    swapSkippedBy?: string[];
    noRemotePresent?: true;
    /** Clean energy share when measured, otherwise the share of microphone-tagged segments. */
    micShare?: number;
    callRms?: number;
    echoOfCall?: number;
    acousticQuality?: "linear-estimate" | "quiet" | "insufficient";
}

export async function readSpeakers(
    params: MeetingsParsedParams<"meeting.speakers">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"meeting.speakers">> {
    const record = recordOf(store, params.meeting);
    // One opened meeting for the statistics and the evidence: the source and the attendance load once.
    const opened = OpenedMeeting.of(store, record, deps.linkedSource?.(record));
    const stats = await speakerStatsRead({
        store,
        record,
        opened,
        gapSec: params.gapSec ?? DEFAULT_SPAN_GAP_SEC,
        ...(params.attendance ? { attendance: params.attendance } : {}),
    });
    if (!params.evidence) {
        return stats;
    }
    const meeting = await opened.meeting();
    const energy = await opened.energy();
    const raw = rawMeeting({
        record,
        meeting,
        evidence: await opened.evidence(),
        energyMicShare: energy.share,
        callSilent: await opened.silentCallSpans(),
        presence: await opened.presence(params.attendance),
        points: [],
        localSpeech: localSpeechDuring({ start: meeting.start, end: meeting.end }),
    });
    const summary = [
        ...(raw.meeting.indicatorGaps ?? []).map(
            (gap) => `Indicator gap ${gap.fromSec}s to ${gap.toSec}s: ${gap.reason}`
        ),
        ...(raw.meeting.labels ?? []).map(
            (label) =>
                `${label.label}: first own indicator ${label.firstOwnIndicatorSec ?? "unknown"}s; first join ${label.firstJoinSec ?? "unknown"}s; ${label.lines} earlier lines`
        ),
        ...raw.people
            .filter((person) => person.origin === "indicator")
            .map((person) => `${person.name}: indicator only`),
        ...raw.lines.filter((line) => line.localSpeechOutput).map((line) => `${line.fromSec}s: local speech output`),
    ];
    return { ...stats, evidence: { summary, lines: compactEvidence(raw) } };
}

export async function readScreen(
    params: MeetingsParsedParams<"meeting.screen">,
    store: MeetingStore
): Promise<MeetingsResult<"meeting.screen">> {
    const record = recordOf(store, params.meeting);
    let timeline: Awaited<ReturnType<typeof screenTimeline>>;

    try {
        timeline = await screenTimeline({ store, record });
    } catch (error) {
        // A meeting without a screen recording has no frames: the window shows no screen pane.
        if (error instanceof Error && error.message.includes("no screen recording")) {
            return { meeting: record.id, recorded: false, displays: [], frames: [] };
        }

        throw error;
    }

    const frames = timeline.frames
        .filter(
            (frame) =>
                (params.fromSec === undefined || frame.meetingSec >= params.fromSec) &&
                (params.toSec === undefined || frame.meetingSec <= params.toSec) &&
                (params.display === undefined || frame.displayId === params.display)
        )
        .map((frame) => ({
            file: frame.file,
            path: frame.path,
            meetingSec: frame.meetingSec,
            ...(frame.displayId === undefined ? {} : { displayId: frame.displayId }),
            ...(frame.focusedDisplayId === undefined ? {} : { focusedDisplayId: frame.focusedDisplayId }),
            width: frame.width,
            height: frame.height,
            lineCount: frame.lineCount,
        }));
    return {
        meeting: record.id,
        recorded: true,
        displays: timeline.displays,
        frames,
        ...(timeline.recordingSpans === undefined ? {} : { recordingSpans: timeline.recordingSpans }),
        ...(timeline.displaySpans === undefined ? {} : { displaySpans: timeline.displaySpans }),
    };
}

export async function readTimeline(
    params: MeetingsParsedParams<"meeting.timeline">,
    store: MeetingStore
): Promise<MeetingsResult<"meeting.timeline">> {
    return screenTimeline({ store, record: recordOf(store, params.meeting), all: params.all, frame: params.frame });
}

export async function readWaveform(
    params: MeetingsParsedParams<"meeting.waveform">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): Promise<MeetingsResult<"meeting.waveform">> {
    const record = recordOf(store, params.meeting);
    const fromSec = params.fromSec ?? 0;
    const empty = (toSec: number, cannot: { code: "no-audio" | "no-ffmpeg" | "mono"; message: string }) => ({
        meeting: record.id,
        fromSec,
        toSec,
        peaks: [],
        cannot,
    });
    let audioPath: string;

    try {
        audioPath = await OpenedMeeting.of(store, record, deps.linkedSource?.(record)).audioPath();
    } catch (error) {
        return empty(params.toSec ?? fromSec, {
            code: "no-audio",
            message: error instanceof Error ? error.message : String(error),
        });
    }

    if (!(deps.hasFfmpeg ?? (() => Boolean(Bun.which("ffmpeg"))))()) {
        return empty(params.toSec ?? fromSec, {
            code: "no-ffmpeg",
            message: "ffmpeg is not installed (brew install ffmpeg).",
        });
    }

    // The channel energy the speaker rules read: 100 ms blocks, kept in the meeting folder and rebuilt when the
    // recording is newer, so the strip and every zoom read one table.
    const energy = await (deps.energy ?? channelEnergy)(
        audioPath,
        join(store.folder(record.id), "evidence", "energy.bin")
    );

    if (!energy) {
        return empty(params.toSec ?? fromSec, {
            code: "mono",
            message: "the recording has one channel; its energy is not kept yet.",
        });
    }

    const blocks = Math.min(energy.left.length, energy.right.length);
    const loudness = (block: number) => Math.max(energy.left[block] ?? 0, energy.right[block] ?? 0);
    let loudest = 0;

    for (let block = 0; block < blocks; block += 1) {
        loudest = Math.max(loudest, loudness(block));
    }

    const toSec = params.toSec ?? blocks / ENERGY_BLOCKS_PER_SEC;
    const span = Math.max(0, toSec - fromSec);
    const peaks = Array.from({ length: params.buckets }, (_, bucket) => {
        const first = Math.floor((fromSec + (span * bucket) / params.buckets) * ENERGY_BLOCKS_PER_SEC);
        const last = Math.max(
            first + 1,
            Math.ceil((fromSec + (span * (bucket + 1)) / params.buckets) * ENERGY_BLOCKS_PER_SEC)
        );
        let peak = 0;

        for (let block = first; block < Math.min(last, blocks); block += 1) {
            peak = Math.max(peak, loudness(block));
        }

        return loudest > 0 ? Math.round((peak / loudest) * 1000) / 1000 : 0;
    });
    return { meeting: record.id, fromSec, toSec, peaks };
}

export async function readOverview(params: MeetingsParsedParams<"meetings.overview">, store: MeetingStore) {
    return overviewRead({ days: params.days ?? 14, now: new Date(), store });
}

/** The refusal `config show` prints for a path that names no setting, or a map key that is not there. */
async function refuseUnknownPath(path: string): Promise<void> {
    const segments = parseConfigPath(path);
    const unknown = unknownConfigPath(segments);

    if (unknown) {
        throw refusal("failed", `${unknown.reason} Its settings: ${unknown.settings}`);
    }

    const missing = missingMapKey(await new MeetingsConfigStore().read(), segments);

    if (missing) {
        throw refusal("failed", `${missing.reason} Its settings: ${missing.settings}`);
    }
}

export async function readConfig(params: MeetingsParsedParams<"config.read">): Promise<MeetingsResult<"config.read">> {
    if (params.path) {
        const unknown = unknownConfigPath(parseConfigPath(params.path));

        if (unknown) {
            throw refusal("failed", `${unknown.reason} Its settings: ${unknown.settings}`);
        }
    }

    const view = await configShowRead(params.path);

    if (params.path && (view.value === null || view.value === undefined)) {
        await refuseUnknownPath(params.path);
    }

    return view;
}

export async function setConfig(params: MeetingsParsedParams<"config.set">): Promise<MeetingsResult<"config.set">> {
    const segments = parseConfigPath(params.path);
    const config = await setConfigValue(
        new MeetingsConfigStore(),
        params.path,
        params.value,
        params.expect === undefined ? {} : { expect: params.expect }
    );
    return { path: segments, value: configValueAt(config, segments) ?? null };
}

export async function unsetConfig(
    params: MeetingsParsedParams<"config.unset">
): Promise<MeetingsResult<"config.unset">> {
    const segments = parseConfigPath(params.path);
    const config = await unsetConfigValue(
        new MeetingsConfigStore(),
        params.path,
        params.expect === undefined ? {} : { expect: params.expect }
    );
    return { path: segments, value: configValueAt(config, segments) ?? null };
}
