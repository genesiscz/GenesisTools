import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage, withFileLock } from "@genesiscz/utils/storage";

export interface EffortJournalRecord {
    ts: string;
    workItemId: number;
    timeLogIds: string[];
    minutes: number;
    remainingBefore: number;
    completedBefore: number;
    remainingAfter: number;
    completedAfter: number;
}

const JOURNAL_NAME = "effort-journal.jsonl";

export function effortJournalPath(): string {
    return join(new Storage("azure-devops").getBaseDir(), JOURNAL_NAME);
}

function isRecord(value: unknown): value is EffortJournalRecord {
    if (!value || typeof value !== "object") {
        return false;
    }

    const rec = value as Record<string, unknown>;

    return (
        typeof rec.ts === "string" &&
        typeof rec.workItemId === "number" &&
        Array.isArray(rec.timeLogIds) &&
        rec.timeLogIds.every((id) => typeof id === "string") &&
        typeof rec.minutes === "number" &&
        typeof rec.remainingBefore === "number" &&
        typeof rec.completedBefore === "number" &&
        typeof rec.remainingAfter === "number" &&
        typeof rec.completedAfter === "number"
    );
}

export async function appendEffortJournal(
    record: EffortJournalRecord,
    path: string = effortJournalPath()
): Promise<void> {
    const dir = dirname(path);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    await withFileLock(`${path}.lock`, async () => {
        appendFileSync(path, `${SafeJSON.stringify(record, { strict: true })}\n`);
    });
    logger.debug(
        `[effort-journal] appended #${record.workItemId} ids=${record.timeLogIds.length} minutes=${record.minutes} → ${path}`
    );
}

export function readEffortJournal(path: string = effortJournalPath()): EffortJournalRecord[] {
    if (!existsSync(path)) {
        return [];
    }

    const text = readFileSync(path, "utf-8");
    const records: EffortJournalRecord[] = [];

    for (const line of text.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        try {
            const parsed: unknown = SafeJSON.parse(trimmed, { strict: true });

            if (isRecord(parsed)) {
                records.push(parsed);
            } else {
                logger.debug({ line: trimmed.slice(0, 120) }, "[effort-journal] skipped line with unexpected shape");
            }
        } catch (err) {
            logger.debug({ error: err, line: trimmed.slice(0, 120) }, "[effort-journal] skipped malformed line");
        }
    }

    return records;
}

/** Newest record whose `timeLogIds` contains `timeLogId`, or null. */
export function findNewestEffortJournal(
    timeLogId: string,
    path: string = effortJournalPath()
): EffortJournalRecord | null {
    const records = readEffortJournal(path);

    for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i];

        if (record.timeLogIds.includes(timeLogId)) {
            return record;
        }
    }

    return null;
}
