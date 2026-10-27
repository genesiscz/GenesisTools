import { readSessionBackward } from "@genesiscz/utils/agent-sessions/session-backward";
import type { BackwardRead, ReadBackwardOptions } from "@genesiscz/utils/agent-sessions/types";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { logger } from "@genesiscz/utils/logger";
import { type AmbiguousAnswer, type ChatAnswer, chatAnswers, type OpenDecisionRef } from "./chat-answers";
import { type DecisionRecord, kindOf, readDecisions, recordChatAnswers } from "./store";

const log = logger.child({ component: "question:chat-answers" });

/** A session's newest entries through its provider's reader (`readSessionBackward`). */
export type ReadSession = (
    options: ReadBackwardOptions & { kind: string; transcriptPath: string }
) => Promise<BackwardRead>;

/**
 * The decisions of `session` that a chat answer can still settle: open, or with a pick staged and not sent. One rule
 * for the decision Stop hook, the backfill and the inbox's `chatAnswered` list.
 */
export function openChatDecisions(rows: readonly DecisionRecord[], session: string): DecisionRecord[] {
    return rows.filter(
        (row) =>
            row.sessionId === session && kindOf(row) === "decision" && (row.state === "open" || row.state === "drafted")
    );
}

/** When a decision was asked as it stands: its latest revision, else its post. */
export function askedAtOf(row: DecisionRecord): string {
    return row.revisedTs ?? row.createdTs ?? row.updatedTs;
}

function lettersFor(count: number): string[] {
    return Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
}

/** The finder's view of `rows`. `askedBefore` names the rows asked before the first entry that was read. */
export function openDecisionRefs(
    rows: readonly DecisionRecord[],
    askedBefore: (row: DecisionRecord) => boolean = () => false
): OpenDecisionRef[] {
    return rows.map((row) => ({
        number: row.number,
        letters: lettersFor(row.options.length),
        askedAt: askedAtOf(row),
        revision: row.revision ?? 1,
        ...(askedBefore(row) ? { askedBefore: true } : {}),
    }));
}

/** Each found item with the row of its decision number; an item for a number no row has is dropped. */
export function pairAnswers<T extends { number: number }>(
    rows: readonly DecisionRecord[],
    items: readonly T[]
): { row: DecisionRecord; item: T }[] {
    const byNumber = new Map(rows.map((row) => [row.number, row]));

    return items.flatMap((item) => {
        const row = byNumber.get(item.number);

        return row ? [{ row, item }] : [];
    });
}

/** Stores the unambiguous answers as `acknowledged` (`automatic_heuristic`), each against the revision it matched. */
export function recordFoundAnswers({
    file,
    events,
    answers,
}: {
    file: string;
    events: string;
    answers: { row: DecisionRecord; item: ChatAnswer }[];
}): Promise<DecisionRecord[]> {
    return recordChatAnswers({
        file,
        events,
        answers: answers.map(({ row, item }) => ({
            id: row.id,
            expectedRevision: row.revision ?? 1,
            ...(item.option ? { option: item.option } : {}),
            answer: item.answer,
            evidence: item.evidence,
        })),
    });
}

async function transcriptOf(session: string): Promise<{ kind: string; path: string }> {
    const found = await resolveTranscript(session);

    return { kind: found.provider, path: found.filePath };
}

export interface ChatBackfill {
    session: string;
    transcriptPath: string | null;
    open: number[];
    read: { entries: number; found: boolean; issues: string[] };
    unambiguous: ChatAnswer[];
    ambiguous: AmbiguousAnswer[];
    /** The decision ids stored; empty for a dry run. */
    recorded: string[];
}

/**
 * Reads a session's whole transcript back to its oldest open ask, with no byte cap, and finds the user's chat answers
 * to its open decisions: the backlog the decision Stop hook could not reach while it read only the last 8 MB
 * (2026-10-27: nabidky-2.0's D97 to D101 were answered 229 MB from the end). `apply: false` only reports.
 */
export async function backfillChatAnswers({
    session,
    file,
    events,
    apply,
    transcript,
    read = readSessionBackward,
}: {
    session: string;
    file: string;
    events: string;
    apply: boolean;
    /** The session's provider and transcript; found by its id when absent. */
    transcript?: { kind: string; path: string };
    read?: ReadSession;
}): Promise<ChatBackfill> {
    const open = openChatDecisions(readDecisions(file), session);
    const result: ChatBackfill = {
        session,
        transcriptPath: null,
        open: open.map((row) => row.number),
        read: { entries: 0, found: false, issues: [] },
        unambiguous: [],
        ambiguous: [],
        recorded: [],
    };

    if (open.length === 0) {
        return result;
    }

    const source = transcript ?? (await transcriptOf(session));
    const asked = open.map((row) => Date.parse(askedAtOf(row))).filter(Number.isFinite);
    const from = asked.length > 0 ? Math.min(...asked) : 0;
    const entries = await read({
        kind: source.kind,
        transcriptPath: source.path,
        maxBytes: Number.POSITIVE_INFINITY,
        includeBoundaryMessage: true,
        until: (entry) => {
            const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;

            return from > 0 && Number.isFinite(at) && at < from;
        },
    });
    const found = chatAnswers(entries.entries, openDecisionRefs(open));
    result.transcriptPath = source.path;
    result.read = {
        entries: entries.entries.length,
        found: entries.found,
        issues: entries.issues.map((issue) => issue.message),
    };
    result.unambiguous = found.unambiguous;
    result.ambiguous = found.ambiguous;

    if (apply && found.unambiguous.length > 0) {
        const recorded = await recordFoundAnswers({ file, events, answers: pairAnswers(open, found.unambiguous) });
        result.recorded = recorded.map((row) => row.id);
    }

    log.info(
        {
            session,
            transcript: source.path,
            open: result.open,
            entries: result.read.entries,
            unambiguous: found.unambiguous.map((answer) => answer.number),
            ambiguous: found.ambiguous.map((answer) => answer.number),
            recorded: result.recorded,
            apply,
        },
        "chat answers backfill"
    );

    return result;
}
