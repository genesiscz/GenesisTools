/**
 * GitHub-flavoured table rendering from an array of row objects.
 *
 * Three behaviours here are load-bearing and are pinned by `table.test.ts`:
 *  - zero rows returns a sentence, never a header plus rule, because an empty box reads as a
 *    broken generator;
 *  - zero columns throws, because that can only be a programming error;
 *  - a cell is truncated before it is escaped, so a cut never orphans an escaping backslash.
 */

import { Json2mdError } from "./errors";
import { displayWidth, escapeCell, graphemes, padToWidth, truncateToWidth } from "./escape";
import type { Align, ColumnInput, ColumnSet, ColumnSpec, GroupOptions, Row, TableOptions } from "./types";
import { applyHeaderCase, formatScalar, getPath } from "./value";

/** A column after defaults, inference and option merging have been applied. */
interface ResolvedColumn<T> {
    key: string;
    header: string;
    align: Align;
    width?: number;
    maxWidth?: number;
    overflow: "wrap" | "truncateStart" | "truncateEnd";
    empty: string;
    value?: (row: T, index: number) => unknown;
    format?: (value: unknown, row: T, index: number) => string;
}

/** Names a reusable column list, so one row set can be rendered at several subsets. */
export function defineColumns<T = Row>(name: string, columns: ColumnInput<T>[]): ColumnSet<T> {
    return { name, columns };
}

/**
 * Narrows a column list to the named keys, in the order given.
 *
 * This is how one row set yields a wide detail table and a narrow progress table without the
 * columns being written twice.
 */
export function pickColumns<T = Row>(columns: ColumnInput<T>[] | ColumnSet<T>, keys: string[]): ColumnInput<T>[] {
    const list = Array.isArray(columns) ? columns : columns.columns;
    const byKey = new Map<string, ColumnInput<T>>();

    for (const column of list) {
        byKey.set(typeof column === "string" ? column : column.key, column);
    }

    const picked: ColumnInput<T>[] = [];

    for (const key of keys) {
        const found = byKey.get(key);

        if (found === undefined) {
            throw new Json2mdError(
                "UNKNOWN_COLUMN",
                `pickColumns: no column named "${key}". Known columns: ${[...byKey.keys()].join(", ")}`
            );
        }

        picked.push(found);
    }

    return picked;
}

/** Drops the named keys and keeps the rest in their original order. */
export function omitColumns<T = Row>(columns: ColumnInput<T>[] | ColumnSet<T>, keys: string[]): ColumnInput<T>[] {
    const list = Array.isArray(columns) ? columns : columns.columns;
    const drop = new Set(keys);

    return list.filter((column) => !drop.has(typeof column === "string" ? column : column.key));
}

/** The union of keys across every row, in first-seen order. */
export function inferColumns(rows: readonly Row[]): string[] {
    const seen = new Set<string>();

    for (const row of rows) {
        if (row === null || typeof row !== "object") {
            continue;
        }

        for (const key of Object.keys(row)) {
            seen.add(key);
        }
    }

    return [...seen];
}

function resolveAlign<T>(column: ColumnSpec<T> | string, index: number, options: TableOptions<T>): Align {
    if (typeof column !== "string" && column.align !== undefined) {
        return column.align;
    }

    if (Array.isArray(options.align)) {
        return options.align[index] ?? "left";
    }

    return options.align ?? "left";
}

function resolveColumns<T extends Row>(rows: readonly T[], options: TableOptions<T>): ResolvedColumn<T>[] {
    const input: ColumnInput<T>[] = options.columns ?? inferColumns(rows);

    return input.map((column, index) => {
        const spec: ColumnSpec<T> = typeof column === "string" ? { key: column } : column;

        return {
            key: spec.key,
            header: spec.header ?? applyHeaderCase(spec.key, options.headerCase),
            align: resolveAlign(column, index, options),
            width: spec.width,
            maxWidth: spec.maxWidth ?? options.maxWidth,
            overflow: spec.overflow ?? options.overflow ?? "truncateEnd",
            empty: spec.empty ?? options.empty ?? "",
            value: spec.value,
            format: spec.format,
        };
    });
}

function assertKnownKeys<T extends Row>(
    rows: readonly T[],
    columns: ResolvedColumn<T>[],
    options: TableOptions<T>
): void {
    if ((options.unknownKey ?? "ignore") === "ignore") {
        return;
    }

    const covered = new Set(columns.map((column) => column.key));
    const unknown = inferColumns(rows).filter((key) => !covered.has(key));

    if (unknown.length > 0) {
        throw new Json2mdError(
            "UNCOVERED_KEYS",
            `renderTable: rows carry keys no column covers: ${unknown.join(", ")}`
        );
    }
}

/** Turns one value into finished cell text: format, then truncate, then escape. */
function renderCell<T extends Row>(column: ResolvedColumn<T>, row: T, index: number, options: TableOptions<T>): string {
    const raw = column.value ? column.value(row, index) : getPath(row, column.key);

    let text: string;

    if (column.format) {
        text = column.format(raw, row, index);
    } else {
        text = formatScalar(raw, { empty: column.empty, arraySeparator: options.arraySeparator ?? ", " });
    }

    if (options.toCellText) {
        // `text` is the `format` / `empty` result, so the documented order holds: after format.
        text = options.toCellText({ key: column.key, value: raw, row, index, text });
    }

    const stringLength = options.countAnsiEscapeCodes
        ? (value: string) => value.length
        : (options.stringLength ?? displayWidth);
    const budget = column.width ?? column.maxWidth;
    let wrapped = false;

    if (budget !== undefined && stringLength(text) > budget) {
        if (column.overflow === "wrap") {
            text = wrapToWidth(text, budget, stringLength).join("\n");
            wrapped = true;
        } else {
            text = truncateToWidth(text, { max: budget, strategy: column.overflow, stringLength });
        }
    }

    // 🛑 Escaping happens last. Cutting escaped text can split `\|` and merge two columns.
    // A wrapped cell keeps its breaks as `<br>`: the default `strip` turned them back into
    // spaces, so `overflow: "wrap"` did nothing unless the caller also chose `preserve`.
    return escapeCell(text, wrapped ? "preserve" : (options.lineBreak ?? "strip"));
}

/** Greedy word wrap on a display-width budget. Falls back to a hard cut for one long word. */
export function wrapToWidth(
    value: string,
    max: number,
    stringLength: (input: string) => number = displayWidth
): string[] {
    if (max <= 0) {
        return [value];
    }

    const lines: string[] = [];

    for (const paragraph of value.split(/\r\n|\r|\n/)) {
        let line = "";

        for (const word of paragraph.split(/\s+/)) {
            if (word === "") {
                continue;
            }

            const candidate = line === "" ? word : `${line} ${word}`;

            if (stringLength(candidate) <= max) {
                line = candidate;
                continue;
            }

            if (line !== "") {
                lines.push(line);
                line = "";
            }

            if (stringLength(word) <= max) {
                line = word;
                continue;
            }

            let rest = word;

            while (stringLength(rest) > max) {
                let head = truncateToWidth(rest, { max, strategy: "truncateEnd", stringLength, ellipsis: "" });

                if (head === "") {
                    // One grapheme is wider than the whole budget (`日` at max 1). An empty head
                    // left `rest` unchanged and looped forever, so it goes on a line of its own.
                    head = graphemes(rest)[0] ?? rest;

                    if (head === rest) {
                        // The last one stays the open line, like any short tail.
                        break;
                    }
                }

                lines.push(head);
                rest = rest.slice(head.length);
            }

            line = rest;
        }

        lines.push(line);
    }

    return lines;
}

/** `:-:` is the shortest rule that still carries an alignment marker on both sides. */
const MIN_RULE_WIDTH = 3;

function alignmentRule(align: Align, width: number, pad: boolean): string {
    if (!pad) {
        if (align === "center") {
            return ":---:";
        }

        if (align === "right") {
            return "---:";
        }

        return "---";
    }

    // The caller already floored the column width at MIN_RULE_WIDTH, so the rule fits the
    // column exactly and the source table lines up in a plain editor.
    const size = Math.max(width, MIN_RULE_WIDTH);

    if (align === "center") {
        return `:${"-".repeat(size - 2)}:`;
    }

    if (align === "right") {
        return `${"-".repeat(size - 1)}:`;
    }

    return "-".repeat(size);
}

/**
 * Renders one GitHub table.
 *
 * @throws when `options.columns` is empty, or when `unknownKey` is `throw` and a row carries
 *         a key no column covers.
 */
export function renderTable<T extends Row>(rows: readonly T[], options: TableOptions<T> = {}): string {
    const columns = resolveColumns(rows, options);

    if (columns.length === 0) {
        if (options.columns !== undefined) {
            throw new Json2mdError("NO_COLUMNS", "renderTable needs at least one column");
        }

        return options.emptyText ?? "_No rows._";
    }

    if (rows.length === 0) {
        return options.emptyText ?? "_No rows._";
    }

    assertKnownKeys(rows, columns, options);

    const stringLength = options.countAnsiEscapeCodes
        ? (value: string) => value.length
        : (options.stringLength ?? displayWidth);
    const headers = columns.map((column) =>
        escapeCell(
            options.toHeaderTitle ? options.toHeaderTitle({ key: column.key, title: column.header }) : column.header
        )
    );
    const body = rows.map((row, index) => columns.map((column) => renderCell(column, row, index, options)));

    const pad = options.alignDelimiters ?? true;
    const widths = columns.map((column, index) => {
        const cells = [headers[index]!, ...body.map((cells) => cells[index]!)];
        const natural = column.width ?? Math.max(...cells.map(stringLength));

        // The alignment rule cannot be narrower than MIN_RULE_WIDTH, so a narrower column
        // would leave the rule row one cell wider than every other row.
        return pad ? Math.max(natural, MIN_RULE_WIDTH) : natural;
    });

    const padCells = (cells: string[]): string =>
        `| ${cells.map((cell, index) => (pad ? padToWidth(cell, widths[index]!, columns[index]!.align, stringLength) : cell)).join(" | ")} |`;

    const ruleRow = `| ${columns
        .map((column, index) => alignmentRule(column.align, widths[index]!, options.padHeaderSeparator ?? pad))
        .join(" | ")} |`;

    return [padCells(headers), ruleRow, ...body.map(padCells)].join("\n");
}

function groupKeyOf<T extends Row>(row: T, index: number, by: GroupOptions<T>["by"]): string {
    if (typeof by === "function") {
        return by(row, index);
    }

    return formatScalar(getPath(row, by), { empty: "(none)" });
}

/**
 * Splits rows by a key and renders one heading plus one table per group.
 *
 * Group order defaults to first appearance, which keeps a regenerated document stable when
 * the source order is stable.
 */
export function renderGroupedTables<T extends Row>(
    rows: readonly T[],
    options: TableOptions<T> & { group: GroupOptions<T> }
): string {
    const { group, ...tableOptions } = options;
    const buckets = new Map<string, T[]>();

    rows.forEach((row, index) => {
        const key = groupKeyOf(row, index, group.by);
        const bucket = buckets.get(key);

        if (bucket) {
            bucket.push(row);
        } else {
            buckets.set(key, [row]);
        }
    });

    let names = [...buckets.keys()];

    if (group.sort === "alpha") {
        names = names.sort((a, b) => a.localeCompare(b));
    } else if (typeof group.sort === "function") {
        names = names.sort(group.sort);
    }

    const level = group.headingLevel ?? 3;
    const sections: string[] = [];

    for (const name of names) {
        const bucket = buckets.get(name)!;
        const base = group.heading ? group.heading(name, bucket) : name;
        const heading = group.showCounts ? `${base} (${bucket.length})` : base;

        sections.push(`${"#".repeat(level)} ${heading}`);
        sections.push(renderTable(bucket, tableOptions));
    }

    if (sections.length === 0) {
        return options.emptyText ?? "_No rows._";
    }

    return sections.join("\n\n");
}
