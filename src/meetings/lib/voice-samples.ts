import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import {
    addVoicePrint,
    readVoiceStore,
    removeVoicePrint,
    type VoicePrint,
} from "@genesiscz/utils/meetings/voice-store";
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

    if (action.kind !== "confirm" || action.minConfidence !== undefined) {
        return [];
    }

    return entry.changes.flatMap((change): ConfirmedVoice[] => {
        const after = change.after;
        if (
            after?.kind !== "speaker-range" ||
            after.status !== "confirmed" ||
            change.before?.status === "confirmed" ||
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
    return confirmedVoices(entry, people).map((voice) => ({ entry, voice }));
}

/** A backfill can decode all the confirmed windows of one recording in the same pass. */
export async function prepareVoicePrints<T extends VoiceTarget>(opened: OpenedMeeting, targets: T[], dryRun = false) {
    const project = opened.record.project;
    if (!project || !targets.length) {
        return [];
    }
    const energy = await opened.energy();
    const lines = lineEvidence(
        (await opened.meeting()).transcript,
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
    const eligible = targets.map(({ voice, saved }) =>
        spans.filter(
            (line) =>
                line.fromSec >= voice.fromSec &&
                line.toSec <= voice.endSec &&
                (!voice.seat || voice.seat === line.seat) &&
                !saved?.some(
                    ({ after }) =>
                        after.fromSec === line.fromSec && after.toSec === line.toSec && after.seat === line.seat
                )
        )
    );
    const wanted = new Set(eligible.flat().map((line) => line.index));
    const embeddings = wanted.size
        ? await embedSeatLines({
              lines: spans.filter((line) => wanted.has(line.index)),
              sound: await opened.sound(),
              // An explicit empty path selects the call-local VoiceLineCache without an on-disk file.
              ...(dryRun ? { cachePath: "" } : {}),
          })
        : [];
    const byLine = new Map(embeddings.map((line) => [line.index, line]));
    const hashes = new Map<string, string>();
    const people = readVoiceStore(project).people;
    const results = [];
    for (const [i, target] of targets.entries()) {
        const lines = eligible[i]!.flatMap(({ index }) => byLine.get(index) ?? []);
        const changes = await printsOf({
            ...target,
            meeting: opened.record.id,
            project,
            lines,
            hashes,
            samples: people[target.voice.person]?.samples ?? [],
        });
        results.push({ target, changes });
    }
    return results;
}

async function printsOf(options: {
    meeting: string;
    project: string;
    entry: JournalEntry;
    voice: ConfirmedVoice;
    lines: VoiceLine[];
    samples: VoicePrint[];
    hashes: Map<string, string>;
}): Promise<VoicePrintChange[]> {
    const { project, entry, voice, hashes } = options;
    const changes: VoicePrintChange[] = [];
    for (const line of options.lines) {
        const channel = line.channels[0];
        if (channel?.quality !== "ready") {
            continue;
        }

        let sourceSha = hashes.get(channel.source.audioPath);
        if (!sourceSha) {
            const hash = createHash("sha256");
            for await (const chunk of createReadStream(channel.source.audioPath)) {
                hash.update(chunk);
            }
            sourceSha = hash.digest("hex");
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
        const before = options.samples.find(
            (sample) =>
                sample.meeting === after.meeting &&
                sample.sourceSha === after.sourceSha &&
                sample.track === after.track &&
                sample.fromSec === after.fromSec &&
                sample.toSec === after.toSec
        );
        changes.push({ project, person: voice.person, model: channel.model, ...(before ? { before } : {}), after });
    }

    return changes;
}

export function writeAnsweredVoiceSamples(changes: readonly VoicePrintChange[]): void {
    const written: VoicePrintChange[] = [];
    try {
        for (const change of changes) {
            addVoicePrint(change.project, change.person, change.after, change.model);
            written.push(change);
        }
    } catch (error) {
        undoAnsweredVoiceSamples(written);
        throw error;
    }
}

export async function saveAnsweredVoiceSamples(options: {
    opened: OpenedMeeting;
    entry: JournalEntry;
}): Promise<VoicePrintChange[]> {
    const changes = await prepareAnsweredVoiceSamples(options);
    writeAnsweredVoiceSamples(changes);
    return changes;
}

const CONFIRMING_KINDS = new Set(["question", "speaker-range"]);

/** Restore only samples owned by items whose confirmation changed, including Undo of an Undo. */
export function transitionAnsweredVoiceSamples(options: {
    entry: JournalEntry;
    entryOf: (token: string) => JournalEntry | undefined;
}): () => void {
    const removed: VoicePrintChange[] = [];
    const added: VoicePrintChange[] = [];
    for (const change of options.entry.changes) {
        const was = change.before;
        const next = change.after;
        // The items whose confirmation owns prints: a speaker question's answer, a voice-named range's confirm.
        if (!CONFIRMING_KINDS.has(was?.kind ?? "") && !CONFIRMING_KINDS.has(next?.kind ?? "")) {
            continue;
        }
        const beforeToken = was?.status === "confirmed" ? was.decision?.token : undefined;
        const afterToken = next?.status === "confirmed" ? next.decision?.token : undefined;
        if (beforeToken === afterToken) {
            continue;
        }
        if (beforeToken) {
            removed.push(
                ...(options.entryOf(beforeToken)?.voices ?? []).filter((voice) => voice.after.question === change.id)
            );
        }
        if (afterToken && afterToken !== options.entry.token) {
            added.push(
                ...(options.entryOf(afterToken)?.voices ?? []).filter((voice) => voice.after.question === change.id)
            );
        }
    }
    const owned = removed.filter((change) =>
        readVoiceStore(change.project).people[change.person]?.samples.some(
            (sample) => SafeJSON.stringify(sample) === SafeJSON.stringify(change.after)
        )
    );
    added.push(...(options.entry.voices ?? []));
    // Snapshot ownership at the moment of the write, so another answer's later sample survives rollback.
    const captured = added.map((change) => ({
        ...change,
        before: readVoiceStore(change.project).people[change.person]?.samples.find(
            (sample) =>
                sample.meeting === change.after.meeting &&
                sample.sourceSha === change.after.sourceSha &&
                sample.track === change.after.track &&
                sample.fromSec === change.after.fromSec &&
                sample.toSec === change.after.toSec
        ),
    }));
    const rollback = () => {
        undoAnsweredVoiceSamples(captured);
        writeAnsweredVoiceSamples(owned);
    };
    try {
        undoAnsweredVoiceSamples(owned);
        writeAnsweredVoiceSamples(captured);
    } catch (error) {
        rollback();
        throw error;
    }
    return rollback;
}

/** Replay persisted embeddings in journal file order (oldest first); no source sound or model is needed. */
export function replayAnsweredVoiceSamples(entries: readonly JournalEntry[]): void {
    const known = new Map<string, JournalEntry>();
    for (const entry of entries) {
        transitionAnsweredVoiceSamples({ entry, entryOf: (token) => known.get(token) });
        known.set(entry.token, entry);
    }
}

/** Undo removes only a print this answer still owns; a later confirmation survives. */
export function undoAnsweredVoiceSamples(changes: readonly VoicePrintChange[]): void {
    for (const change of [...changes].reverse()) {
        const samples = readVoiceStore(change.project).people[change.person]?.samples ?? [];
        const at = samples.filter(
            (sample) => sample.meeting === change.after.meeting && sample.fromSec === change.after.fromSec
        );
        if (!at.some((sample) => SafeJSON.stringify(sample) === SafeJSON.stringify(change.after))) {
            continue;
        }
        removeVoicePrint(change.project, change.person, {
            meeting: change.after.meeting,
            fromSec: change.after.fromSec,
        });
        for (const sample of at.filter((sample) => SafeJSON.stringify(sample) !== SafeJSON.stringify(change.after))) {
            addVoicePrint(change.project, change.person, sample, change.model);
        }
        if (change.before) {
            addVoicePrint(change.project, change.person, change.before, change.model);
        }
    }
}
