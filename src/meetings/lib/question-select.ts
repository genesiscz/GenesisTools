import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { NewQuestion } from "./questions";

/** Questions with the same choices closer than this become one cluster question. */
const CLUSTER_GAP_SEC = 30;
/** A coarse range whose time finer evidence items cover this much is not asked: the finer items are. */
const COVERED_SHARE = 0.8;

function numberOf(question: NewQuestion, key: string): number {
    const value = question.evidence?.[key];
    return typeof value === "number" ? value : 0;
}

function labelsOf(question: NewQuestion): string[] {
    const value = question.evidence?.labels;
    return Array.isArray(value) ? value.filter((label): label is string => typeof label === "string") : [];
}

/** The seconds of `[fromSec, toSec]` that the given spans cover together. */
function coveredSec(fromSec: number, toSec: number, spans: Array<{ fromSec: number; toSec: number }>): number {
    const clipped = spans
        .map((span) => ({ fromSec: Math.max(fromSec, span.fromSec), toSec: Math.min(toSec, span.toSec) }))
        .filter((span) => span.toSec > span.fromSec)
        .sort((a, b) => a.fromSec - b.fromSec);
    let covered = 0;
    let reached = fromSec;

    for (const span of clipped) {
        covered += Math.max(0, span.toSec - Math.max(reached, span.fromSec));
        reached = Math.max(reached, span.toSec);
    }

    return covered;
}

/**
 * A question about a transcript-level range (a goodbye range of R1/R5, an attendance range of RA) is coarse: when
 * finer items of the audio evidence (E1) on the same label cover 80 % of its time, they are asked instead.
 */
function isCoarse(question: NewQuestion, items: MeetingItem[]): boolean {
    const decided = items.filter((item) => question.decides.includes(item.id) && item.kind === "speaker-range");
    const transcriptLevel = (item: MeetingItem) =>
        item.rules.includes(MeetingRule.LeavePhrase) || item.rules.includes(MeetingRule.Attendance);
    const span = question.toSec - question.fromSec;

    if (decided.length === 0 || !decided.every(transcriptLevel) || span <= 0) {
        return false;
    }

    const labels = new Set(decided.map((item) => (item.kind === "speaker-range" ? item.label : "")));
    const finer = items.flatMap((item) =>
        item.kind === "speaker-range" &&
        !question.decides.includes(item.id) &&
        item.rules.includes(MeetingRule.Channel) &&
        labels.has(item.label)
            ? [
                  {
                      fromSec: item.fromSec,
                      toSec: typeof item.evidence?.endSec === "number" ? item.evidence.endSec : item.toSec,
                  },
              ]
            : []
    );
    return coveredSec(question.fromSec, question.toSec, finer) / span >= COVERED_SHARE;
}

/** Only questions about the same labeled audio passage can share one answer. */
function clusterKey(question: NewQuestion): string | undefined {
    if (question.about !== "speaker" || !question.clip || labelsOf(question).length !== 1) {
        return undefined;
    }
    return `${labelsOf(question)[0]}|${question.fromSec}|${question.toSec}|${question.clip.fromSec}|${question.clip.toSec}|${[...question.choices].sort().join("|")}`;
}

function clipLength(question: NewQuestion): number {
    return question.clip ? question.clip.toSec - question.clip.fromSec : 0;
}

/** One question for a run of neighbours with the same choices: it decides all their items. */
function merge(into: NewQuestion, next: NewQuestion): NewQuestion {
    const labels = [...new Set([...labelsOf(into), ...labelsOf(next)])];
    const ranges = into.decides.length + next.decides.length;
    const toSec = Math.max(into.toSec, next.toSec);
    const words = numberOf(into, "words") + numberOf(next, "words");
    return {
        ...into,
        toSec,
        question: `Who speaks under ${labels.map((label) => `"${label}"`).join(", ")} from ${formatClock(into.fromSec)} to ${formatClock(toSec)} (${ranges} ranges)?`,
        decides: [...into.decides, ...next.decides],
        confidence: Math.min(into.confidence ?? 1, next.confidence ?? 1),
        clip: clipLength(next) > clipLength(into) ? next.clip : into.clip,
        evidence: {
            ...into.evidence,
            words,
            impact: Math.max(numberOf(into, "impact"), numberOf(next, "impact")) + Math.log2(ranges),
            labels,
        },
    };
}

/**
 * From the candidate questions, the ones worth asking, each with its priority:
 * 1. a coarse question whose time finer items mostly cover is dropped;
 * 2. neighbours (30 s apart or less) offering the same people become one cluster question;
 * 3. priority = (1 − confidence) × impact × reach, where reach counts the questions that share the signature (the same
 *    top choices and the same people present), because one answer settles them all.
 */
export function selectQuestions(candidates: NewQuestion[], items: MeetingItem[]): NewQuestion[] {
    const kept = candidates.filter((question) => !isCoarse(question, items)).sort((a, b) => a.fromSec - b.fromSec);
    const clustered: NewQuestion[] = [];
    const lastOf = new Map<string, number>();

    for (const question of kept) {
        const key = clusterKey(question);
        const at = key === undefined ? undefined : lastOf.get(key);
        const last = at === undefined ? undefined : clustered[at];

        if (key !== undefined && at !== undefined && last && question.fromSec - last.toSec <= CLUSTER_GAP_SEC) {
            clustered[at] = merge(last, question);
            continue;
        }

        clustered.push(question);

        if (key !== undefined) {
            lastOf.set(key, clustered.length - 1);
        }
    }

    const reach = new Map<string, number>();

    for (const question of clustered) {
        reach.set(question.signature ?? "", (reach.get(question.signature ?? "") ?? 0) + 1);
    }

    return clustered.map((question) => {
        const unsure = 1 - (question.confidence ?? 0);
        const impact = Math.max(1, numberOf(question, "impact"));
        const shared = question.signature ? (reach.get(question.signature) ?? 1) : 1;
        return {
            ...question,
            priority: Math.round(unsure * impact * shared * 100) / 100,
            evidence: { ...question.evidence, reach: shared },
        };
    });
}
