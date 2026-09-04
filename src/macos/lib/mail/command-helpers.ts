import {
    ALL_COLUMN_KEYS,
    DEFAULT_LIST_COLUMNS,
    type JsonColumnValue,
    MAIL_COLUMNS,
    type MailColumnDef,
    type MailColumnKey,
    RECIPIENT_COLUMNS,
} from "@app/macos/lib/mail/columns";
import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import { formatResultsTable } from "@app/macos/lib/mail/format";
import * as p from "@clack/prompts";
import { isInteractive, printLn } from "@genesiscz/utils/cli";
import { parseVariadic } from "@genesiscz/utils/cli/variadic";
import { parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MailMessage } from "@genesiscz/utils/macos/mail/types";
import type { MailFilterOptions } from "@genesiscz/utils/macos/mail-sql";

// ─── Column resolution ──────────────────────────────────────

function resolveColumns(rawColumns: string | true | undefined): MailColumnKey[] | "interactive" {
    if (rawColumns === undefined) {
        return DEFAULT_LIST_COLUMNS;
    }

    if (rawColumns === true) {
        return "interactive";
    }

    const parsed = parseVariadic(rawColumns);
    const valid: MailColumnKey[] = [];

    for (const col of parsed) {
        if (ALL_COLUMN_KEYS.includes(col as MailColumnKey)) {
            valid.push(col as MailColumnKey);
        } else {
            p.log.warn(`Unknown column "${col}" — available: ${ALL_COLUMN_KEYS.join(", ")}`);
        }
    }

    if (valid.length === 0) {
        return DEFAULT_LIST_COLUMNS;
    }

    return valid;
}

async function pickColumnsInteractively(): Promise<MailColumnKey[] | null> {
    const result = await p.multiselect({
        message: "Select columns to display:",
        options: ALL_COLUMN_KEYS.map((key) => ({
            value: key,
            label: MAIL_COLUMNS[key].label,
            hint: DEFAULT_LIST_COLUMNS.includes(key) ? "default" : undefined,
        })),
        initialValues: [...DEFAULT_LIST_COLUMNS],
        required: true,
    });

    if (p.isCancel(result)) {
        p.cancel("Operation cancelled");
        return null;
    }

    return result as MailColumnKey[];
}

/**
 * Parse --columns flag value and resolve to a concrete column list.
 * Returns null when user cancels interactive picker.
 */
export async function resolveColumnsFromFlag(rawColumns: string | true | undefined): Promise<MailColumnKey[] | null> {
    const resolved = resolveColumns(rawColumns);

    if (resolved !== "interactive") {
        return resolved;
    }

    if (!isInteractive()) {
        return DEFAULT_LIST_COLUMNS;
    }

    return pickColumnsInteractively();
}

// ─── Date parsing ───────────────────────────────────────────

/**
 * Parse a mail `--from` / `--to` value.
 *
 * Accepts ISO datetimes, `YYYY-MM-DD`, `now`, and relative durations (`14h`, `7d`,
 * `30m`, `1h30m`). Bare numbers are rejected (they are not dates). Date-only values
 * use the local timezone: `--from 2026-04-09` is local midnight, `--to 2026-04-09`
 * with `endOfDay` is local 23:59:59.999.
 */
export function parseMailDate(str: string | undefined, endOfDay = false): Date | undefined {
    if (!str) {
        return undefined;
    }

    const trimmed = str.trim();

    if (trimmed === "now") {
        return new Date();
    }

    if (!/^\d+$/.test(trimmed)) {
        const durationMs = parseDuration(trimmed);

        if (durationMs > 0) {
            return new Date(Date.now() - durationMs);
        }
    }

    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);

    if (day) {
        const year = Number(day[1]);
        const month = Number(day[2]) - 1;
        const date = Number(day[3]);

        if (endOfDay) {
            return new Date(year, month, date, 23, 59, 59, 999);
        }

        return new Date(year, month, date, 0, 0, 0, 0);
    }

    const d = new Date(trimmed);

    if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid date: "${str}". Use YYYY-MM-DD, ISO, now, or a duration like 14h / 7d.`);
    }

    return d;
}

/**
 * A calendar day the way the user typed it: LOCAL, matching parseMailDate's
 * local midnight.
 *
 * `toISOString().slice(0, 10)` shifts a local midnight back a day anywhere east
 * of UTC, so `--from 2026-04-09` was echoed as 2026-04-08 in the destructive
 * rebuild confirmation, against a SQL window that was in fact correct.
 */
export function formatLocalDay(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type MailListCliOptions = {
    from?: string;
    to?: string;
    sender?: string;
    receiver?: string;
    account?: string;
    unread?: boolean;
    read?: boolean;
    flagged?: boolean;
    hasAttachment?: boolean;
    offset?: string;
    limit?: string;
};

/**
 * Turn `mail list` flags into SQL filter options. Throws when `--read` and
 * `--unread` are both set, or when `--offset` is not a non-negative integer.
 */
export function resolveListFilters(options: MailListCliOptions): {
    filters: MailFilterOptions;
    limit: number;
    offset: number;
} {
    if (options.read && options.unread) {
        throw new Error("Use either --read or --unread, not both.");
    }

    const rawOffset = options.offset ?? "0";
    const offset = Number.parseInt(rawOffset, 10);

    if (!Number.isFinite(offset) || offset < 0 || String(offset) !== rawOffset.trim()) {
        throw new Error(`Invalid --offset "${rawOffset}". Use a non-negative integer.`);
    }

    const rawLimit = options.limit ?? "20";
    const limit = Number.parseInt(rawLimit, 10);

    if (!Number.isFinite(limit) || limit < 1 || String(limit) !== rawLimit.trim()) {
        throw new Error(`Invalid --limit "${rawLimit}". Use a positive integer.`);
    }

    return {
        filters: {
            from: parseMailDate(options.from),
            to: parseMailDate(options.to, true),
            sender: options.sender,
            receiver: options.receiver,
            account: options.account,
            unread: options.unread || undefined,
            read: options.read || undefined,
            flagged: options.flagged || undefined,
            hasAttachment: options.hasAttachment || undefined,
        },
        limit,
        offset,
    };
}

// ─── Recipient check ────────────────────────────────────────

export function needsRecipients(columns: MailColumnKey[]): boolean {
    return columns.some((col) => RECIPIENT_COLUMNS.includes(col));
}

const BODY_COLUMN_KEYS: MailColumnKey[] = ["body", "bodyText", "bodyHtml", "bodyMarkdown", "bodyRaw"];

function wantsBodyColumn(columns: MailColumnKey[]): boolean {
    return columns.some((col) => BODY_COLUMN_KEYS.includes(col));
}

// ─── Body enrichment ────────────────────────────────────────

export async function enrichWithBodies(messages: MailMessage[], columns: MailColumnKey[]): Promise<void> {
    if (!wantsBodyColumn(columns) || messages.length === 0) {
        return;
    }

    const emlx = await EmlxBodyExtractor.create();

    try {
        const rowids = messages.map((m) => m.rowid);
        const bodyParts = await emlx.getBodyPartsMap(rowids);

        for (const msg of messages) {
            const parts = bodyParts.get(msg.rowid);

            if (parts) {
                msg.body = parts.text;
                msg.bodyText = parts.text;
                msg.bodyHtml = parts.html;
                msg.bodyMarkdown = parts.markdown;
                msg.bodyRaw = parts.raw;
            }
        }
    } finally {
        emlx.dispose();
    }
}

// ─── Output formatting ──────────────────────────────────────

export function formatJsonOutput(messages: MailMessage[], columns: MailColumnKey[]): string {
    const data = messages.map((msg) => {
        const obj: Record<string, JsonColumnValue> = {};

        for (const col of columns) {
            const def: MailColumnDef = MAIL_COLUMNS[col];
            obj[col] = def.getValue ? def.getValue(msg) : def.get(msg);
        }

        return obj;
    });

    return SafeJSON.stringify(data, null, 2);
}

export function isStructuredFormat(format: string | undefined): boolean {
    return format === "json" || format === "toon";
}

/** Print structured result data to stdout: as JSON, or as TOON via `tools json`. */
export async function printStructured(data: unknown, format: string): Promise<void> {
    const jsonStr = typeof data === "string" ? data : SafeJSON.stringify(data, null, 2);

    if (format === "toon") {
        const proc = Bun.spawn(["tools", "json"], {
            stdin: new Blob([jsonStr]),
            stdout: "inherit",
            stderr: "inherit",
        });
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            p.log.warn(`toon format failed (exit code ${exitCode}), falling back to JSON`);
            await printLn(jsonStr);
        }

        return;
    }

    await printLn(jsonStr);
}

export async function outputFormattedResults({
    messages,
    columns,
    format,
}: {
    messages: MailMessage[];
    columns: MailColumnKey[];
    format: string;
}): Promise<void> {
    if (isStructuredFormat(format)) {
        await printStructured(formatJsonOutput(messages, columns), format);
        return;
    }

    if (format !== "table") {
        p.log.warn(`Unknown format "${format}" — using table`);
    }

    await printLn(["", formatResultsTable(messages, columns)]);
}
