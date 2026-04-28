import pc from "picocolors";

export interface ColumnSchema<T> {
    header: string;
    get: (row: T) => string | number | null | undefined;
    align?: "left" | "right";
    minWidth?: number;
    maxWidth?: number;
    color?: (raw: string, row: T) => string;
}

export interface RenderColumnsOpts<T> {
    rows: T[];
    schema: ColumnSchema<T>[];
    emptyMessage?: string;
}

export function renderColumns<T>(opts: RenderColumnsOpts<T>): string {
    if (!opts.rows.length) {
        return pc.dim(opts.emptyMessage ?? "(no rows)");
    }

    const cells = opts.rows.map((row) => opts.schema.map((column) => stringify(column.get(row))));
    const widths = opts.schema.map((column, index) => {
        const headerWidth = column.header.length;
        const cellWidth = Math.max(...cells.map((row) => stripAnsi(row[index]).length));

        return clamp(
            Math.max(headerWidth, cellWidth),
            column.minWidth ?? 0,
            column.maxWidth ?? Number.POSITIVE_INFINITY
        );
    });
    const header = opts.schema
        .map((column, index) => pc.bold(pad(column.header, widths[index], column.align ?? "left")))
        .join("  ");
    const separator = opts.schema.map((_, index) => pc.dim("─".repeat(widths[index]))).join("  ");
    const body = cells.map((row, rowIndex) =>
        row
            .map((cell, columnIndex) => {
                const schema = opts.schema[columnIndex];
                const padded = pad(truncate(cell, widths[columnIndex]), widths[columnIndex], schema.align ?? "left");

                return schema.color ? schema.color(padded, opts.rows[rowIndex]) : padded;
            })
            .join("  ")
    );

    return [header, separator, ...body].join("\n");
}

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function stripAnsi(value: string): string {
    return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function pad(value: string, width: number, align: "left" | "right"): string {
    const visible = stripAnsi(value).length;
    if (visible >= width) {
        return value;
    }

    const padding = " ".repeat(width - visible);

    return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

function truncate(value: string, width: number): string {
    if (stripAnsi(value).length <= width) {
        return value;
    }

    return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function stringify(value: string | number | null | undefined): string {
    if (value === null || value === undefined) {
        return "";
    }

    return typeof value === "number" ? String(value) : value;
}
