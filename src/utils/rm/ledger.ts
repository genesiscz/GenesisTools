import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { rmDataDir } from "./config";
import type { RmCaller } from "./rules";

export type RmLedgerAction =
    | "move"
    | "aside"
    | "return"
    | "drain"
    | "restore"
    | "refuse"
    | "request"
    | "approve"
    | "deny"
    | "root-add"
    | "root-remove"
    | "profile-set"
    | "profile-remove";

/** One line of `~/.genesis-tools/rm/ledger.jsonl`: every move, deletion, restore, refusal and decision. */
export interface RmLedgerEntry {
    at: string;
    action: RmLedgerAction;
    path?: string;
    batchId?: string;
    requestId?: string;
    rule?: string;
    reason?: string;
    /** Bytes moved (move, aside: measured after the rename) or reclaimed (drain). */
    bytes?: number;
    /** Where an aside or trash move put it. */
    stored?: string;
    /** The folder the command ran in. */
    cwd?: string;
    caller?: RmCaller | null;
    /** How a person confirmed: `tty` or `dialog`. */
    via?: string;
}

export function rmLedgerPath(): string {
    return rmDataDir("ledger.jsonl");
}

export function appendRmLedger(entry: Omit<RmLedgerEntry, "at"> & { at?: string }, path = rmLedgerPath()): void {
    const line: RmLedgerEntry = { ...entry, at: entry.at ?? new Date().toISOString(), cwd: entry.cwd ?? process.cwd() };

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

export interface RmLedgerFilter {
    since?: Date;
    /** An agent name (`claude-code`, `codex`, ...) or `person`. */
    agent?: string;
    /** A session id or its prefix. */
    session?: string;
    actions?: readonly string[];
    /** Entries whose path contains this text. */
    path?: string;
}

/** Who did it, as one word: the agent, or `person` for a run outside any agent. */
export function ledgerAgent(entry: RmLedgerEntry): string {
    const caller = entry.caller;

    if (!caller) {
        return "unknown";
    }

    return caller.isInAgent ? caller.agent : "person";
}

export function filterRmLedger(entries: readonly RmLedgerEntry[], filter: RmLedgerFilter): RmLedgerEntry[] {
    const since = filter.since?.getTime();

    return entries.filter((entry) => {
        if (since !== undefined && Date.parse(entry.at) < since) {
            return false;
        }

        if (filter.agent && ledgerAgent(entry) !== filter.agent) {
            return false;
        }

        if (filter.session && !entry.caller?.sessionId?.startsWith(filter.session)) {
            return false;
        }

        if (filter.actions && filter.actions.length > 0 && !filter.actions.includes(entry.action)) {
            return false;
        }

        return !filter.path || (entry.path ?? "").includes(filter.path);
    });
}

export const RM_LEDGER_GROUPS = ["agent", "session", "day", "rule", "action"] as const;
export type RmLedgerGroup = (typeof RM_LEDGER_GROUPS)[number];

export interface RmLedgerTotal {
    key: string;
    /** Bytes moved into the trash. */
    moved: number;
    /** Bytes moved aside for the user's decision. */
    aside: number;
    /** Bytes the drain freed. */
    reclaimed: number;
    /** Paths moved to the trash or aside. */
    items: number;
    refused: number;
    requests: number;
}

function groupKey(entry: RmLedgerEntry, by: RmLedgerGroup): string {
    switch (by) {
        case "agent":
            return entry.caller?.isInAgent || !entry.caller
                ? ledgerAgent(entry)
                : `person${entry.caller.user ? ` (${entry.caller.user})` : ""}`;
        case "session":
            return `${ledgerAgent(entry)} ${entry.caller?.sessionId ? entry.caller.sessionId.slice(0, 8) : "no session"}`;
        case "day":
            return new Date(entry.at).toLocaleDateString("sv-SE");
        case "rule":
            return entry.rule ?? "(none)";
        case "action":
            return entry.action;
    }
}

/** Totals per agent, session, day, rule or action: what moved, what waits aside, what the drain reclaimed. */
export function totalRmLedger(entries: readonly RmLedgerEntry[], by: RmLedgerGroup): RmLedgerTotal[] {
    const totals = new Map<string, RmLedgerTotal>();
    const titles = new Map<string, string>();

    for (const entry of entries) {
        const key = groupKey(entry, by);

        if (by === "session" && entry.caller?.sessionTitle) {
            titles.set(key, entry.caller.sessionTitle);
        }

        const total = totals.get(key) ?? { key, moved: 0, aside: 0, reclaimed: 0, items: 0, refused: 0, requests: 0 };
        const bytes = entry.bytes ?? 0;

        if (entry.action === "move") {
            total.moved += bytes;
            total.items++;
        } else if (entry.action === "aside") {
            total.aside += bytes;
            total.items++;
        } else if (entry.action === "drain") {
            total.reclaimed += bytes;
        } else if (entry.action === "refuse") {
            total.refused++;
        } else if (entry.action === "request") {
            total.requests++;
        }

        totals.set(key, total);
    }

    return [...totals.values()]
        .map((total) => (titles.has(total.key) ? { ...total, key: `${total.key} ${titles.get(total.key)}` } : total))
        .sort((a, b) => b.reclaimed + b.moved + b.aside - (a.reclaimed + a.moved + a.aside));
}

export function isRmLedgerGroup(value: string): value is RmLedgerGroup {
    return RM_LEDGER_GROUPS.some((group) => group === value);
}
