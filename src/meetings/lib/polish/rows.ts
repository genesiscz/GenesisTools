import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { itemWhat } from "../item-text";
import { lineSpeakerFacts, type SpeakerRange } from "../look";
import { openQuestions, type QuestionItem, questionNumber } from "../questions";

/** One transcript line in the speaker diff: the source's label against the person the record now names. */
export interface SpeakerRow {
    index: number;
    atSec: number;
    /** The source's label. */
    label: string;
    text: string;
    /** The person, or null when no decision and no suggestion names one. */
    name: string | null;
    /** 1 for a person's decision; a suggestion's own confidence; null when nothing names the line. */
    confidence: number | null;
    /** The evidence: the decision's or the suggestion's reason. */
    why: string;
}

function reasonOf(item: SpeakerRange | undefined): string | undefined {
    const reason = item?.decision?.entry?.reason ?? item?.evidence?.reason;
    return typeof reason === "string" && reason.trim() !== "" ? reason : undefined;
}

/**
 * Every line of a record's transcript with the person `look` names for it (the confirmed name, else the last
 * suggestion) and that decision's confidence and reason.
 */
export function speakerRows(
    record: MeetingRecord,
    transcript: readonly TranscriptEntry[],
    phrases: { confirmed: string }
): SpeakerRow[] {
    const facts = lineSpeakerFacts(record, { fromSec: 0, toSec: Number.POSITIVE_INFINITY });

    return transcript.map((entry, index) => {
        const atSec = entry.startSec ?? 0;
        const { suggested, confirmed, assigned, multiple, globalName } = facts({
            index,
            label: entry.speaker,
            startSec: atSec,
        });
        const confirmedName = assigned?.person ?? (multiple ? null : (confirmed?.speaker ?? globalName));
        const voices = multiple ? (confirmed?.voices ?? confirmed?.segments?.map((part) => part.speaker)) : undefined;
        const base = { index, atSec, label: entry.speaker, text: entry.text };

        if (confirmedName) {
            return { ...base, name: confirmedName, confidence: 1, why: reasonOf(confirmed) ?? phrases.confirmed };
        }

        if (suggested?.speaker) {
            return {
                ...base,
                name: suggested.speaker,
                confidence: suggested.confidence ?? null,
                why: reasonOf(suggested) ?? itemWhat(suggested),
            };
        }

        if (voices?.length) {
            return { ...base, name: voices.join(" + "), confidence: 1, why: reasonOf(confirmed) ?? phrases.confirmed };
        }

        return { ...base, name: null, confidence: null, why: "" };
    });
}

/** One term or removal item of the record, for the "Terms and removals" diff. */
export interface TermRow {
    id: string;
    atSec: number;
    heard: string;
    /** What the transcript shows instead: the spelling, the quote, or the heard words with their meaning. */
    becomes: string;
    confidence: number | null;
    reason: string;
}

type TermItem = Extract<MeetingItem, { kind: "term" }>;
type RemovalItem = Extract<MeetingItem, { kind: "removal" }>;

function becomes(item: TermItem): string {
    return item.proposed ?? item.quote?.text ?? (item.meaning ? `${item.heard} (${item.meaning})` : item.heard);
}

/** The record's term and removal items that are not rejected, in transcript order. */
export function termRows(record: MeetingRecord): TermRow[] {
    const rows = record.items.flatMap((item): TermRow[] => {
        if (item.status === "rejected" || (item.kind !== "term" && item.kind !== "removal")) {
            return [];
        }

        const reason = typeof item.evidence?.reason === "string" ? item.evidence.reason : "";
        const confidence = item.confidence ?? null;

        if (item.kind === "removal") {
            const removal: RemovalItem = item;
            return [{ id: removal.id, atSec: removal.fromSec, heard: removal.heard, becomes: "", confidence, reason }];
        }

        return [{ id: item.id, atSec: item.atSec ?? 0, heard: item.heard, becomes: becomes(item), confidence, reason }];
    });

    return rows.sort((a, b) => a.atSec - b.atSec);
}

/** One open listen question with the number `tools meetings listen` shows. */
export interface QuestionRow {
    label: string;
    fromSec: number;
    /** `itemWhat` without its leading time range: the question and its choices. */
    text: string;
}

/** The record's open questions by their `Q<n>` number. */
export function questionRows(record: MeetingRecord): QuestionRow[] {
    return openQuestions(record)
        .map((question: QuestionItem) => ({
            n: questionNumber(record, question.id),
            label: `Q${questionNumber(record, question.id)}`,
            fromSec: question.fromSec,
            text: itemWhat(question).replace(/^\S+–\S+ /, ""),
        }))
        .sort((a, b) => a.n - b.n)
        .map(({ label, fromSec, text }) => ({ label, fromSec, text }));
}
