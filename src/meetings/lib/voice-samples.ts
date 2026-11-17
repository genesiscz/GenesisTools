import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
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
import type { LabelContext } from "./speaker-labels/types";
import { embedSeatLines } from "./speaker-labels/voice";

export interface VoicePrintChange {
    project: string;
    person: string;
    model: string;
    before?: VoicePrint;
    after: VoicePrint;
}

/** Extract without writing: the journal publishes these prints together with the answer. */
export async function prepareAnsweredVoiceSamples(options: {
    opened: OpenedMeeting;
    entry: JournalEntry;
}): Promise<VoicePrintChange[]> {
    const { opened, entry } = options;
    const record = opened.record;
    if (!record.project || entry.action.kind !== "answer" || !["window", "listen", "cli"].includes(entry.actor.kind)) {
        return [];
    }
    const question = entry.changes.map((change) => change.after).find((item) => item?.id === entry.question);
    if (
        question?.kind !== "question" ||
        question.about !== "speaker" ||
        question.status !== "confirmed" ||
        !question.answer?.trim()
    ) {
        return [];
    }
    const person = question.answer.trim();
    // A split or a comment is not a single person's confirmed name. A missing attendance row is not a veto.
    if (![...question.choices, ...recordPeople(record)].some((name) => sameName(name, person))) {
        return [];
    }
    const energy = await opened.energy();
    const lines = lineEvidence(
        (await opened.meeting()).transcript,
        (await opened.evidence()) ?? { segments: [], speaking: [] },
        undefined,
        energy.share
    );
    const questionEnd =
        typeof question.evidence?.endSec === "number" && Number.isFinite(question.evidence.endSec)
            ? Math.max(question.toSec, question.evidence.endSec)
            : question.toSec;
    const eligible: LabelContext["lines"][number][] = lines.flatMap((line) => {
        const share = line.micShare ?? line.energyMic;
        if (share === undefined || share === 0.5 || line.startSec < question.fromSec || line.endSec > questionEnd) {
            return [];
        }
        const seat = share > 0.5 ? "mic" : "call";
        return [{ index: line.index, fromSec: line.startSec, toSec: line.endSec, seat }];
    });
    const embeddings = await embedSeatLines({ lines: eligible, sound: await opened.sound() });
    const hashes = new Map<string, string>();
    const changes: VoicePrintChange[] = [];
    for (const line of embeddings) {
        const voice = line.channels[0];
        if (voice?.quality !== "ready") {
            continue;
        }
        let sourceSha = hashes.get(voice.source.audioPath);
        if (!sourceSha) {
            const hash = createHash("sha256");
            for await (const chunk of createReadStream(voice.source.audioPath)) {
                hash.update(chunk);
            }
            sourceSha = hash.digest("hex");
            hashes.set(voice.source.audioPath, sourceSha);
        }
        const after: VoicePrint = {
            meeting: record.id,
            sourceSha,
            seat: line.seat,
            track: line.track,
            fromSec: line.fromSec!,
            toSec: line.toSec!,
            embedding: voice.embedding,
            confirmedAt: entry.at,
            question: question.id,
        };
        const before = readVoiceStore(record.project).people[person]?.samples.find(
            (sample) =>
                sample.meeting === after.meeting &&
                sample.sourceSha === after.sourceSha &&
                sample.track === after.track &&
                sample.fromSec === after.fromSec &&
                sample.toSec === after.toSec
        );
        changes.push({ project: record.project, person, model: voice.model, ...(before ? { before } : {}), after });
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

/** Restore only samples owned by questions whose answer changed, including Undo of an Undo. */
export function transitionAnsweredVoiceSamples(options: {
    entry: JournalEntry;
    entryOf: (token: string) => JournalEntry | undefined;
}): () => void {
    const removed: VoicePrintChange[] = [];
    const added: VoicePrintChange[] = [];
    for (const change of options.entry.changes) {
        const was = change.before;
        const next = change.after;
        if (was?.kind !== "question" && next?.kind !== "question") {
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
