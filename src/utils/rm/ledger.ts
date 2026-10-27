import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { rmDataDir } from "./config";
import type { RmCaller } from "./rules";

export type RmLedgerAction =
    | "move"
    | "drain"
    | "restore"
    | "refuse"
    | "request"
    | "approve"
    | "deny"
    | "root-add"
    | "root-remove";

/** One line of `~/.genesis-tools/rm/ledger.jsonl`: every move, deletion, restore, refusal and decision. */
export interface RmLedgerEntry {
    at: string;
    action: RmLedgerAction;
    path?: string;
    batchId?: string;
    requestId?: string;
    rule?: string;
    reason?: string;
    bytes?: number;
    caller?: RmCaller | null;
    /** How a person confirmed: `tty` or `dialog`. */
    via?: string;
}

export function rmLedgerPath(): string {
    return rmDataDir("ledger.jsonl");
}

export function appendRmLedger(entry: Omit<RmLedgerEntry, "at"> & { at?: string }, path = rmLedgerPath()): void {
    const line: RmLedgerEntry = { ...entry, at: entry.at ?? new Date().toISOString() };

    try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${SafeJSON.stringify(line)}\n`);
    } catch (error) {
        logger.warn({ path, error, action: entry.action }, "rm: cannot append to the ledger");
    }
}

export function readRmLedger(path = rmLedgerPath()): RmLedgerEntry[] {
    if (!existsSync(path)) {
        return [];
    }

    const entries: RmLedgerEntry[] = [];

    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            const parsed: unknown = SafeJSON.parse(line, { strict: true });

            if (isLedgerEntry(parsed)) {
                entries.push(parsed);
            }
        } catch (error) {
            logger.debug({ path, error }, "rm: skipping an unreadable ledger line");
        }
    }

    return entries;
}

function isLedgerEntry(value: unknown): value is RmLedgerEntry {
    return (
        typeof value === "object" &&
        value !== null &&
        "action" in value &&
        typeof value.action === "string" &&
        "at" in value &&
        typeof value.at === "string"
    );
}
