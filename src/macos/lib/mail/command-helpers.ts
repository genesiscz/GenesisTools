import {
    ALL_COLUMN_KEYS,
    DEFAULT_LIST_COLUMNS,
    MAIL_COLUMNS,
    type MailColumnKey,
    RECIPIENT_COLUMNS,
} from "@app/macos/lib/mail/columns";
import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import { formatResultsTable } from "@app/macos/lib/mail/format";
import type { MailMessage } from "@app/macos/lib/mail/types";
import { isInteractive } from "@app/utils/cli";
import { parseVariadic } from "@app/utils/cli/variadic";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";

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
 * Parse a YYYY-MM-DD (or ISO) date string. For `endOfDay=true` bare dates
 * are bumped to 23:59:59.999 UTC so `--to 2026-04-09` includes the whole day.
 */
export function parseMailDate(str: string | undefined, endOfDay = false): Date | undefined {
    if (!str) {
        return undefined;
    }

    const d = new Date(str);

    if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid date: "${str}". Use YYYY-MM-DD format.`);
    }

    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(str)) {
        d.setUTCHours(23, 59, 59, 999);
    }

    return d;
}

// ─── Recipient check ────────────────────────────────────────

export function needsRecipients(columns: MailColumnKey[]): boolean {
    return columns.some((col) => RECIPIENT_COLUMNS.includes(col));
}

// ─── Body enrichment ────────────────────────────────────────

export async function enrichWithBodies(messages: MailMessage[], columns: MailColumnKey[]): Promise<void> {
    if (!columns.includes("body") || messages.length === 0) {
        return;
    }

    const emlx = await EmlxBodyExtractor.create();

    try {
        const rowids = messages.map((m) => m.rowid);
        const bodies = await emlx.getBodies(rowids);

        for (const msg of messages) {
            const body = bodies.get(msg.rowid);

            if (body) {
                msg.body = body;
            }
        }
    } finally {
        emlx.dispose();
    }
}

// ─── Output formatting ──────────────────────────────────────

export function formatJsonOutput(messages: MailMessage[], columns: MailColumnKey[]): string {
    const data = messages.map((msg) => {
        const obj: Record<string, string> = {};

        for (const col of columns) {
            obj[col] = MAIL_COLUMNS[col].get(msg);
        }

        return obj;
    });

    return SafeJSON.stringify(data, null, 2);
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
    if (format === "json") {
        console.log(formatJsonOutput(messages, columns));
        return;
    }

    if (format === "toon") {
        const jsonStr = formatJsonOutput(messages, columns);
        const proc = Bun.spawn(["tools", "json"], {
            stdin: new Blob([jsonStr]),
            stdout: "inherit",
            stderr: "inherit",
        });
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            p.log.warn(`toon format failed (exit code ${exitCode}), falling back to JSON`);
            console.log(jsonStr);
        }

        return;
    }

    if (format !== "table") {
        p.log.warn(`Unknown format "${format}" — using table`);
    }

    console.log("");
    console.log(formatResultsTable(messages, columns));
}
