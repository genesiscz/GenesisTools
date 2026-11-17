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

/** Called by the decision writer only after a person's speaker answer is saved. */
export async function saveAnsweredVoiceSamples(options: {
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
    // A split, "nobody", or free text that does not identify an attended person cannot seed a voice.
    const stays = (await opened.presence())?.filter((stay) => sameName(stay.name, person)) ?? [];
    if (!stays.length) {
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
        if (
            share === undefined ||
            share === 0.5 ||
            line.startSec < question.fromSec ||
            line.endSec > questionEnd ||
            !stays.some((stay) => stay.fromSec <= line.startSec && stay.toSec >= line.endSec)
        ) {
            return [];
        }
        const seat = share > 0.5 ? "mic" : "call";
        const room = record.seats?.room.some((name) => sameName(name, person));
        const self = record.participants.some((participant) => participant.self && sameName(participant.name, person));
        const personSeat = record.seats ? (room || self ? "mic" : "call") : undefined;
        return personSeat === seat ? [{ index: line.index, fromSec: line.startSec, toSec: line.endSec, seat }] : [];
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
        addVoicePrint(record.project, person, after, voice.model);
        changes.push({ project: record.project, person, model: voice.model, ...(before ? { before } : {}), after });
    }
    return changes;
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
