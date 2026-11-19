/**
 * One formatter per result type, and the one printer of a `Reply`. A door (CLI, MCP, REPL) renders a reply through
 * `render`; only `emit` writes to the terminal.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { type Block, json2md } from "@genesiscz/utils/json2md";
import { out } from "@genesiscz/utils/logger";
import { type FormatFlags, type OutputFormat, resolveOutputFormat } from "./formats";
import type { NextAction, Reply } from "./reply";
import { toToon } from "./toon";

export interface FormatContext {
    tty: boolean;
    width: number;
    door?: Door;
}

export interface TableShape {
    columns: { key: string; title: string; max?: number }[];
    rows: Record<string, unknown>[];
}

export interface Formatter<T> {
    text(data: T, ctx: FormatContext): string[];
    /** A result with a table shape gets md, json-compact and toon from it with no more code. */
    table?(data: T): TableShape;
}

export function defineFormatter<T>(formatter: Formatter<T>): Formatter<T> {
    return formatter;
}

/** A door prints a next action in its own form: a command line, a tool call, a REPL call. */
export interface Door {
    commandOf(call: NonNullable<NextAction["call"]>): string;
}

function cell(value: unknown, max?: number): string {
    const text =
        value === undefined || value === null ? "" : typeof value === "string" ? value : SafeJSON.stringify(value);
    return max !== undefined && text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compact(table: TableShape): { cols: string[]; rows: unknown[][] } {
    return {
        cols: table.columns.map((c) => c.key),
        rows: table.rows.map((row) => table.columns.map((c) => row[c.key] ?? null)),
    };
}

function mdOf<T>(data: T, formatter: Formatter<T>, ctx: FormatContext): string {
    const table = formatter.table?.(data);

    if (table !== undefined) {
        const blocks: Block[] = [
            {
                table: {
                    rows: table.rows.map((row) =>
                        Object.fromEntries(table.columns.map((c) => [c.title, cell(row[c.key], c.max)]))
                    ),
                },
            },
        ];
        return json2md(blocks);
    }

    return json2md([{ code: { language: "text", content: formatter.text(data, ctx).join("\n") } }]);
}

export function nextActionLine(action: NextAction, door?: Door): string {
    const how = action.call ? door?.commandOf(action.call) : action.ask;
    return `next: ${action.do}${how ? `: ${how}` : ""}`;
}

/** Diagnostics and next actions as lines for stderr. */
export function sideLines<T>(reply: Reply<T>, door: Door): string[] {
    return [
        ...reply.diagnostics.map((d) => `${d.severity}: ${d.code}: ${d.message}`),
        ...reply.next.map((action) => nextActionLine(action, door)),
    ];
}

/** Pure: what a reply prints in a format. `json` is the whole reply; the other formats print its data. */
export function render<T>(
    reply: Reply<T>,
    formatter: Formatter<T>,
    format: OutputFormat,
    ctx: FormatContext & { door: Door }
): { stdout: string; stderr: string[] } {
    if (format === "json") {
        return { stdout: SafeJSON.stringify(reply), stderr: [] };
    }

    const stderr = sideLines(reply, ctx.door);

    if (!reply.ok) {
        return { stdout: "", stderr };
    }

    const notes = [
        ...(reply.dryRun ? ["(dry run: nothing was written)"] : []),
        ...(reply.receipt?.replayed
            ? [`(replayed the stored reply of request ${reply.receipt.requestId ?? "?"})`]
            : []),
    ];
    switch (format) {
        case "json-compact": {
            const table = formatter.table?.(reply.data);
            return { stdout: SafeJSON.stringify(table ? compact(table) : reply.data), stderr: [...notes, ...stderr] };
        }
        case "toon": {
            const table = formatter.table?.(reply.data);
            return { stdout: toToon(table ? table.rows : reply.data), stderr: [...notes, ...stderr] };
        }
        case "md":
            return { stdout: mdOf(reply.data, formatter, ctx), stderr: [...notes, ...stderr] };
        case "text":
            return { stdout: [...notes, ...formatter.text(reply.data, ctx)].join("\n"), stderr };
    }
}

/** The one printer: the result on stdout, diagnostics and next actions on stderr, exit code 1 when `ok` is false. */
export function emit<T>(reply: Reply<T>, formatter: Formatter<T>, flags: FormatFlags, door: Door): void {
    const format = resolveOutputFormat(flags);
    const tty = process.stdout.isTTY === true;
    const { stdout, stderr } = render(reply, formatter, format, { tty, width: process.stdout.columns ?? 120, door });

    if (stdout.length > 0) {
        out.print(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
    }

    for (const line of stderr) {
        out.printlnErr(line);
    }

    if (!reply.ok) {
        process.exitCode = 1;
    }
}
