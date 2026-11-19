import { isDeepStrictEqual } from "node:util";
import { sha256FileAsync } from "@genesiscz/utils/fs/hash";
import { type FileIdentity, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { sha256Json } from "@genesiscz/utils/hash";
import { voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import {
    type ConfirmedSampleInput,
    changeVoiceLearning,
    meetingVoiceOwner,
    readVoiceLibrary,
    refused,
    type SampleId,
    type SampleSource,
    sourceForVoicePrint,
    type VoiceOwner,
    voiceLineKeys,
} from "@genesiscz/utils/meetings/voice-library";
import type { VoicePrint } from "@genesiscz/utils/meetings/voice-store";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { JournalEntry } from "./decision-actions";
import { recordPeople } from "./listen-answers";
import type { OpenedMeeting } from "./opened-meeting";
import { NONE_OF_THESE } from "./questions";
import type { Seat } from "./sound";
import type { LabelContext } from "./speaker-labels/types";
import { embedSeatLines } from "./speaker-labels/voice";
import type { VoiceLine } from "./voice-names";

export interface VoicePrintChange {
    project: string;
    person: string;
    model: string;
    source?: SampleSource;
    owner?: VoiceOwner;
    id?: SampleId;
    token?: string;
    item?: string;
    origin?: "answer" | "confirm";
    acquiredBy?: "live" | "backfill";
    before?: VoicePrint;
    after: VoicePrint;
}

/** The stretch of a decision that a person confirmed by ear, and whose voice it is (`item`: the deciding item). */
interface ConfirmedVoice {
    item: string;
    person: string;
    fromSec: number;
    /** The end of the stretch: its own end, or the end of its last line (`evidence.endSec`) when later. */
    endSec: number;
    seat?: Seat;
}

function stretchEnd(item: { toSec: number; evidence?: Record<string, unknown> }): number {
    const end = item.evidence?.endSec;
    return typeof end === "number" && Number.isFinite(end) ? Math.max(item.toSec, end) : item.toSec;
}

/** answerQuestion stores several speakers as an ordered list joined with " + ", also on the decided range. */
function singleSpeaker(name: string | undefined): name is string {
    return !!name?.trim() && !name.includes(" + ") && name.trim().toLowerCase() !== NONE_OF_THESE;
}

/**
 * What a person's decision confirmed by ear: the answer of a speaker question by one person (P5, decision 3), or a
 * confirm of speaker ranges the voice model named (P7, decision 2: "a confirm adds a sample"), each item listed by
 * hand. A confirm of every item above a confidence (`minConfidence`) is no one's ear and confirms nothing here.
 */
function confirmedVoices(entry: JournalEntry, people: readonly string[]): ConfirmedVoice[] {
    const action = entry.action;
    if (action.kind === "answer") {
        const question = entry.changes.map((change) => change.after).find((item) => item?.id === entry.question);
        if (
            question?.kind !== "question" ||
            question.about !== "speaker" ||
            question.status !== "confirmed" ||
            !singleSpeaker(question.answer)
        ) {
            return [];
        }

        const person = question.answer.trim();
        // A split or a comment is not a single person's confirmed name. A missing attendance row is not a veto.
        return [...question.choices, ...people].some((name) => sameName(name, person))
            ? [{ item: question.id, person, fromSec: question.fromSec, endSec: stretchEnd(question) }]
            : [];
    }

    if (action.kind !== "confirm" || action.minConfidence !== undefined || !action.items.length) {
        return [];
    }

    return entry.changes.flatMap((change): ConfirmedVoice[] => {
        const after = change.after;
        if (
            after?.kind !== "speaker-range" ||
            after.status !== "confirmed" ||
            change.before?.status === "confirmed" ||
            (!entry.decided.includes(after.id) && !action.items.includes(after.id)) ||
            after.segments?.length ||
            after.decision?.token !== entry.token ||
            !singleSpeaker(after.speaker) ||
            (after.voices?.length ?? 0) > 1 ||
            !after.rules.includes(MeetingRule.VoiceEmbedding)
        ) {
            return [];
        }

        const named =
            change.before?.kind === "speaker-range" ? [change.before.speaker, ...(change.before.candidates ?? [])] : [];
        const person = after.speaker;
        if (![...named, ...people].some((name) => name !== undefined && sameName(name, person))) {
            return [];
        }

        const seat = after.evidence?.seat;
        return [
            {
                item: after.id,
                person,
                fromSec: after.fromSec,
                endSec: stretchEnd(after),
                ...(seat === "mic" || seat === "call" ? { seat } : {}),
            },
        ];
    });
}

/** Extract without writing: the journal publishes these prints together with the decision. */
export async function prepareAnsweredVoiceSamples(options: {
    opened: OpenedMeeting;
    entry: JournalEntry;
}): Promise<VoicePrintChange[]> {
    const { opened, entry } = options;
    if (!opened.record.project) {
        return [];
    }
    const targets = answeredVoiceTargets(entry, recordPeople(opened.record));
    return (await prepareVoicePrints(opened, targets)).flatMap(({ changes }) => changes);
}

export interface VoiceTarget {
    entry: JournalEntry;
    voice: ConfirmedVoice;
    /** Already journaled for this item and project; replay these windows without embedding them again. */
    saved?: VoicePrintChange[];
}

export function answeredVoiceTargets(entry: JournalEntry, people: readonly string[]): VoiceTarget[] {
    if (!["answer", "confirm"].includes(entry.action.kind) || !["window", "listen", "cli"].includes(entry.actor.kind)) {
        return [];
    }
    // Listen replayed an earlier human answer: that answer already gave its samples, so it is not a second confirmation.
    if (entry.action.kind === "answer" && entry.action.knownAnswer) {
        return [];
    }
    return confirmedVoices(entry, people).map((voice) => ({ entry, voice }));
}

/** A backfill can decode all the confirmed windows of one recording in the same pass. */
export async function prepareVoicePrints<T extends VoiceTarget>(
    opened: OpenedMeeting,
    targets: T[],
    options: {
        dryRun?: boolean;
        signal?: AbortSignal;
        planned?: (count: number) => void;
        guardPublication?: boolean;
    } = {}
) {
    const { dryRun, signal } = options;
    const project = opened.record.project;
    if (!project || !targets.length) {
        return [];
    }
    signal?.throwIfAborted();
    const energy = await opened.energy();
    const meeting = await opened.meeting();
    const rootMeeting = voiceRootMeeting(opened.store, opened.record);
    const keys = voiceLineKeys(meeting);
    const transcriptVersion = sha256Json(meeting.transcript);
    const lines = lineEvidence(
        meeting.transcript,
        (await opened.evidence()) ?? { segments: [], speaking: [] },
        undefined,
        energy.share
    );
    const spans: LabelContext["lines"][number][] = lines.flatMap((line) => {
        const share = line.micShare ?? line.energyMic;
        if (share === undefined || share === 0.5) {
            return [];
        }
        return [{ index: line.index, fromSec: line.startSec, toSec: line.endSec, seat: share > 0.5 ? "mic" : "call" }];
    });
    const { library } = readVoiceLibrary();
    const refusals = targets.map(() => new Map<string, number>());
    const eligible = targets.map(({ voice, saved }, i) =>
        spans
            .filter(
                (line) =>
                    line.fromSec >= voice.fromSec &&
                    line.toSec <= voice.endSec &&
                    (!voice.seat || voice.seat === line.seat) &&
                    !saved?.some(
                        ({ after, source }) =>
                            (!source?.spanKey || source.lineKey === keys[line.index]) &&
                            after.fromSec === line.fromSec &&
                            after.toSec === line.toSec &&
                            after.seat === line.seat
                    )
            )
            .filter((line) => {
                const reason = refused(
                    library,
                    { rootMeeting, lineKey: keys[line.index]!, recordingKey: "" },
                    meetingVoiceOwner(opened.record, voice.person)
                );
                if (reason) {
                    const counts = refusals[i]!;
                    counts.set(reason, (counts.get(reason) ?? 0) + 1);
                }
                return !reason;
            })
    );
    options.planned?.(
        targets.reduce(
            (sum, target, i) =>
                sum +
                Math.max(
                    1,
                    (target.saved?.length ?? 0) +
                        eligible[i]!.length +
                        [...refusals[i]!.values()].reduce((sum, n) => sum + n, 0)
                ),
            0
        )
    );
    const wanted = new Set(eligible.flat().map((line) => line.index));
    const embeddings = wanted.size
        ? await embedSeatLines({
              lines: spans.filter((line) => wanted.has(line.index)),
              sound: await opened.sound(),
              config: await opened.config(),
              signal,
              // An explicit empty path selects the call-local VoiceLineCache without an on-disk file.
              ...(dryRun ? { cachePath: "" } : {}),
          })
        : [];
    const byLine = new Map(embeddings.map((line) => [line.index, line]));
    const hashes = new Map<string, string>();
    const files = new Map<string, FileIdentity>();
    const results = [];
    for (const [i, target] of targets.entries()) {
        const lines = eligible[i]!.flatMap(({ index }) => byLine.get(index) ?? []);
        const changes = await printsOf({
            ...target,
            owner: meetingVoiceOwner(opened.record, target.voice.person),
            meeting: opened.record.id,
            project,
            lines,
            hashes,
            files: options.guardPublication ? files : undefined,
            keys,
            rootMeeting,
        });
        results.push({
            target,
            changes,
            transcriptVersion,
            refusals: refusals[i]!,
            missing: eligible[i]!.length - changes.length,
            audioCurrent: () => [...files].every(([path, identity]) => isDeepStrictEqual(fileIdentity(path), identity)),
        });
    }
    return results;
}

async function printsOf(options: {
    meeting: string;
    project: string;
    entry: JournalEntry;
    voice: ConfirmedVoice;
    owner: VoiceOwner;
    lines: VoiceLine[];
    keys: string[];
    rootMeeting: string;
    hashes: Map<string, string>;
    files?: Map<string, FileIdentity>;
}): Promise<VoicePrintChange[]> {
    const { project, entry, voice, hashes } = options;
    const changes: VoicePrintChange[] = [];
    for (const line of options.lines) {
        const channel = line.channels[0];
        if (channel?.quality !== "ready") {
            continue;
        }

        const path = channel.source.audioPath;
        if (options.files) {
            const identity = fileIdentity(path);
            if (
                !identity ||
                identity.size !== channel.source.size ||
                identity.mtimeMs !== channel.source.mtimeMs ||
                (options.files.has(path) && !isDeepStrictEqual(options.files.get(path), identity))
            ) {
                continue;
            }
            options.files.set(path, identity);
        }
        let sourceSha = hashes.get(channel.source.audioPath);
        if (!sourceSha) {
            sourceSha = await sha256FileAsync(channel.source.audioPath);
            hashes.set(channel.source.audioPath, sourceSha);
        }

        const after: VoicePrint = {
            meeting: options.meeting,
            sourceSha,
            seat: line.seat,
            track: line.track,
            fromSec: line.fromSec!,
            toSec: line.toSec!,
            embedding: channel.embedding,
            confirmedAt: entry.at,
            question: voice.item,
        };
        changes.push({
            project,
            owner: options.owner,
            person: voice.person,
            model: channel.model,
            after,
            token: entry.token,
            origin: entry.action.kind === "confirm" ? "confirm" : "answer",
            source: sourceForVoicePrint(after, options.rootMeeting, options.keys[line.index]),
        });
    }

    return changes;
}

function learningInput(change: VoicePrintChange): ConfirmedSampleInput {
    return {
        project: change.project,
        owner: change.owner ?? { name: change.person },
        model: change.model,
        print: change.after,
        source: change.source ?? sourceForVoicePrint(change.after),
        origin: change.origin ?? "answer",
        acquiredBy: change.acquiredBy ?? "live",
        ...(change.token && (change.item || change.after.question)
            ? { decision: { token: change.token, item: (change.item ?? change.after.question)! } }
            : {}),
    };
}

export function publishVoiceChanges(
    changes: readonly VoicePrintChange[],
    dryRun = false,
    removed: readonly VoicePrintChange[] = []
) {
    return changeVoiceLearning({
        add: changes.map(learningInput),
        remove: removed.map((change) => ({
            project: change.project,
            model: change.model,
            owner: change.owner ?? { name: change.person },
            print: change.after,
            before: change.before,
            source: change.source,
            token: change.token,
            id: change.id,
        })),
        dryRun,
    });
}

export async function saveAnsweredVoiceSamples(options: {
    opened: OpenedMeeting;
    entry: JournalEntry;
}): Promise<VoicePrintChange[]> {
    const changes = await prepareAnsweredVoiceSamples(options);
    const { results } = publishVoiceChanges(changes);
    return changes.flatMap((change, i) => {
        const result = results[i];
        return result?.status === "added" ? [{ ...change, id: result.id }] : [];
    });
}

/** Old journals have just the print and the deciding item. Match its v1 payload and human decision on replay. */
export function journalVoices(entry: JournalEntry | undefined, item?: string, project?: string): VoicePrintChange[] {
    if (!entry?.voices?.length) {
        return [];
    }
    const targets = answeredVoiceTargets(
        entry,
        entry.voices.map((change) => change.person)
    );
    return entry.voices.flatMap((change) => {
        const decidingItem = change.item ?? change.after.question;
        const matching = targets.filter(
            (t) =>
                (!decidingItem || t.voice.item === decidingItem) &&
                sameName(t.voice.person, change.person) &&
                (!t.voice.seat || t.voice.seat === change.after.seat) &&
                change.after.fromSec >= t.voice.fromSec &&
                change.after.toSec <= t.voice.endSec
        );
        const target = matching.length === 1 ? matching[0] : undefined;
        if (
            !target ||
            (item && item !== target.voice.item) ||
            !change.project ||
            (project !== undefined && change.project !== project) ||
            entry.meeting !== change.after.meeting
        ) {
            return [];
        }
        return [
            {
                ...change,
                item: target.voice.item,
                token: entry.token,
                origin: entry.action.kind === "confirm" ? "confirm" : "answer",
            },
        ];
    });
}

export function transitionAnsweredVoiceSamples(options: {
    entry: JournalEntry;
    entryOf: (token: string) => JournalEntry | undefined;
    project?: string;
}): () => void {
    const removed: VoicePrintChange[] = [];
    const added: VoicePrintChange[] = [];
    for (const change of options.entry.changes) {
        const before = change.before?.status === "confirmed" ? change.before.decision?.token : undefined;
        const after = change.after?.status === "confirmed" ? change.after.decision?.token : undefined;
        if (before === after) {
            continue;
        }
        if (before) {
            removed.push(...journalVoices(options.entryOf(before), change.id));
        }
        if (after && after !== options.entry.token) {
            added.push(...journalVoices(options.entryOf(after), change.id, options.project));
        }
    }
    const own = journalVoices(options.entry, undefined, options.project);
    const batch = publishVoiceChanges([...added, ...own], false, removed);
    if (own.length && options.entry.voices) {
        options.entry.voices = own.flatMap((change, i) => {
            const result = batch.results[i + added.length];
            return result?.status === "added" ? [{ ...change, id: result.id }] : [];
        });
    }
    return batch.rollback;
}

export function replayAnsweredVoiceSamples(entries: readonly JournalEntry[]): void {
    const known = new Map<string, JournalEntry>();
    for (const entry of entries) {
        transitionAnsweredVoiceSamples({ entry: structuredClone(entry), entryOf: (token) => known.get(token) });
        known.set(entry.token, entry);
    }
}

export function undoAnsweredVoiceSamples(changes: readonly VoicePrintChange[]): void {
    publishVoiceChanges([], false, changes);
}
