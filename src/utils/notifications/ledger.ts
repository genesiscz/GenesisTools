import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * The one record of every notification any GenesisTools or Genesis surface sent, or decided not to send:
 * `~/.genesis-tools/notifications/ledger.jsonl`, one JSON object per line. The Swift apps write the same
 * file with the same fields (GenesisKit `NotificationLedger.swift`), so "what pinged me in the last 40 hours,
 * and why" is one read (Martin, 2026-10-23: "make sure GenesisTools and GenesisPlayground are being logged
 * for every of those notifications"). Before this, Genesis.app's cache banners were logged nowhere, and the
 * macOS unified log kept about 14 hours of them without titles.
 */
export function notificationLedgerPath(): string {
    return genesisToolsDir("notifications", "ledger.jsonl");
}

/** Past this size the file moves to `ledger.jsonl.1` (replacing the older one) and a new file starts. */
export const NOTIFICATION_LEDGER_MAX_BYTES = 20 * 1024 * 1024;

export interface NotificationLedgerEntry {
    /** What produced it: `claude-usage`, `hub`, `monitor.cache`, `disk`, ... */
    source: string;
    /** Where it went: `macos`, `in-app`, `telegram`, `webhook`, `say`. */
    channel: string;
    /** `posted`, `failed`, `suppressed` (a rule decided against it; `reason` says which), or `withdrawn`. */
    outcome: "posted" | "failed" | "suppressed" | "withdrawn";
    title?: string;
    subtitle?: string;
    body?: string;
    reason?: string;
    [field: string]: unknown;
}

/** Appends one line. Never throws: a ledger write must not stop a notification. */
export function recordNotification(entry: NotificationLedgerEntry): void {
    const path = notificationLedgerPath();

    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

        if (existsSync(path) && statSync(path).size > NOTIFICATION_LEDGER_MAX_BYTES) {
            renameSync(path, `${path}.1`);
        }

        const line = {
            at: new Date().toISOString(),
            ...entry,
            writer: { app: "tools", pid: process.pid, argv: process.argv.slice(2, 4) },
        };
        appendFileSync(path, `${SafeJSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error) {
        logger.warn({ error, path, source: entry.source }, "notification ledger: could not write the line");
    }
}
