import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexRoot } from "@genesiscz/utils/codex/worker-paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { JsonlWriter } from "@genesiscz/utils/log-session/jsonl-writer";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { manifestChangedLines } from "@genesiscz/utils/worker/contract";
import type { GateCheck } from "./gate";
import type { CodexReviewConfig, CodexReviewSpent, ReviewVerdict } from "./types";

const log = logger.child({ component: "codex:review-ledger" });

/** `~/.genesis-tools/codex/reviews.jsonl`: one line per review start, review turn and gate decision. */
export function reviewLedgerPath(): string {
    return join(codexRoot(), "reviews.jsonl");
}

export interface ReviewLedgerBase {
    v: 1;
    ts: string;
    name: string;
    chain: string;
    label?: string;
    pr?: number;
    branch?: string;
    /** Null only on an imported review whose base or worktree could not be found. */
    base: string | null;
    files: number | null;
    lines: number | null;
    /** A review tier; an imported session keeps whatever effort it ran at. */
    effort: string;
    /** Backfilled by `tools codex reviews import` from a session that ran before the ledger existed. */
    imported?: true;
    /** Imported: the commit the review is taken to have read (the last one before the session started). */
    head?: string;
}

export interface ReviewStartRecord extends ReviewLedgerBase {
    kind: "start";
    cwd: string;
    effortSource: CodexReviewConfig["effortSource"] | "imported";
    allowShallow: boolean;
    parent?: string;
}

export interface ReviewTurnRecord extends ReviewLedgerBase {
    kind: "turn";
    turn: number;
    outcome: "completed" | "failed" | "interrupted";
    model: string | null;
    durationMs: number | null;
    toolCalls: number;
    reasoningTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    /** The `Files reviewed: n of N` line of the turn's final message; null when it had none. */
    coverage: { reviewed: number; total: number } | null;
}

export interface ReviewGateRecord extends ReviewLedgerBase {
    kind: "gate";
    step: number;
    verdict: ReviewVerdict;
    reason: string;
    coverage: { reviewed: number | null; total: number };
    reasoningPer100Lines: number | null;
    floor: number;
    findings: number;
    malformedFindings: number;
    /** The unread files the gate named, first 40. */
    unread: string[];
    /**
     * Each check's own result and sentence, as the gate decided it. Absent on a gate line written before this field,
     * on an imported one and on a `markReviewShallow` one; `review-depth` then rebuilds an approximation.
     */
    checks?: { coverage: GateCheck; reasoning: GateCheck; shape: GateCheck };
    escalatedTo?: string;
    spent: CodexReviewSpent;
}

export type ReviewLedgerRecord = ReviewStartRecord | ReviewTurnRecord | ReviewGateRecord;

type Distribute<T> = T extends ReviewLedgerRecord ? Omit<T, keyof ReviewLedgerBase> : never;
export type ReviewLedgerEntry = Distribute<ReviewLedgerRecord>;

/** The fields every record of one review session repeats, so a single line answers the reviews filters. */
export function reviewLedgerBase(input: { name: string; review: CodexReviewConfig; label?: string; at?: Date }) {
    const { review } = input;
    return {
        v: 1,
        ts: (input.at ?? new Date()).toISOString(),
        name: input.name,
        chain: review.chain,
        ...(input.label ? { label: input.label } : {}),
        ...(review.pr === undefined ? {} : { pr: review.pr }),
        ...(review.branch ? { branch: review.branch } : {}),
        base: review.base,
        files: review.manifest.files.length,
        lines: manifestChangedLines(review.manifest),
        effort: review.effort,
    } satisfies ReviewLedgerBase;
}

/**
 * Appends one record. Never throws: the ledger is a record of the review, and a failed write must not fail the
 * review turn it describes. The failure is logged with the record's kind and session.
 */
export function appendReviewRecord(
    base: ReviewLedgerBase,
    entry: ReviewLedgerEntry,
    path = reviewLedgerPath()
): ReviewLedgerRecord | null {
    const record: ReviewLedgerRecord = { ...base, ...entry };

    try {
        new JsonlWriter(path).append({ ...record });
        log.debug({ path, kind: record.kind, name: record.name }, "review ledger record written");
        return record;
    } catch (err) {
        log.warn({ err, path, kind: record.kind, name: record.name }, "review ledger write failed");
        return null;
    }
}

/**
 * Appends several records in one write, so they land together or not at all (a torn last line is skipped by the
 * reader). Unlike {@link appendReviewRecord} it reports the failure: `reviews import` must not call a review
 * imported when its lines never reached the ledger.
 */
export function appendReviewRecords(
    records: readonly ReviewLedgerRecord[],
    path = reviewLedgerPath()
): { ok: true } | { ok: false; error: string } {
    try {
        mkdirSync(dirname(path), { recursive: true });
        // A torn last line (a full disk or a killed writer) must stay its own line: appended onto, it would swallow
        // this batch's first record, and a redone import's turns would fold into the old start's row.
        const lead = endsMidLine(path) ? "\n" : "";
        appendFileSync(
            path,
            lead + records.map((record) => `${SafeJSON.stringify(record, { jsonl: true })}\n`).join("")
        );
        log.debug({ path, records: records.length }, "review ledger records written");
        return { ok: true };
    } catch (err) {
        log.warn({ err, path, records: records.length }, "review ledger write failed");
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/** True when the file exists, is not empty and its last byte is not a newline. */
function endsMidLine(path: string): boolean {
    if (!existsSync(path)) {
        return false;
    }

    const fd = openSync(path, "r");
    try {
        const size = fstatSync(fd).size;
        if (size === 0) {
            return false;
        }

        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        return last[0] !== 0x0a;
    } finally {
        closeSync(fd);
    }
}

function isLedgerRecord(value: unknown): value is ReviewLedgerRecord {
    return (
        isObject(value) &&
        value.v === 1 &&
        (value.kind === "start" || value.kind === "turn" || value.kind === "gate") &&
        typeof value.name === "string" &&
        typeof value.ts === "string" &&
        (typeof value.base === "string" || value.base === null)
    );
}

/** Every well-formed record, oldest first; torn or foreign lines are counted in `skipped`. */
export function readReviewRecords(path = reviewLedgerPath()): { records: ReviewLedgerRecord[]; skipped: number } {
    const { rows, skipped } = readJsonlRows<unknown>(path);
    const records = rows.filter(isLedgerRecord);
    return { records, skipped: skipped + rows.length - records.length };
}
