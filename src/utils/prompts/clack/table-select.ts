/**
 * Table-style select prompt: a real column-aligned table (dim header row,
 * per-row status badge, colored cells) plus an optional fixed-height detail
 * zone that follows the focused row. Ported from claude-switcheroo's account
 * picker and generalized for any tabular pick (accounts, models, ports, ...).
 *
 * Renders via @clack/core directly, so it works regardless of which `p`
 * backend a tool selected (inquirer tools included) — table rendering has no
 * inquirer/opentui equivalent. Interactive only: guard with isInteractive().
 */

import { isCancel, SelectPrompt } from "@clack/core";
import { stripAnsi } from "@genesiscz/utils/string";
import pc from "picocolors";

const S_ACTIVE = pc.cyan("◆");
const S_SUBMIT = pc.green("◇");
const S_CANCEL = pc.red("■");
const BAR = pc.gray("│");
const BAR_END = pc.gray("└");
const GAP = "  ";

/**
 * Focus highlight: 256-color 75 (#5fafff), bold — a light azure with strong
 * contrast on dark terminal backgrounds, distinct from the cyan frame.
 */
export function accent(text: string): string {
    return `\x1b[1;38;5;75m${text}\x1b[22;39m`;
}

export function visibleWidth(text: string): number {
    return stripAnsi(text).length;
}

/** Pad an ANSI-colored string to a visible width. */
export function padVisible(text: string, width: number, align: "left" | "right" = "left"): string {
    const pad = Math.max(0, width - visibleWidth(text));
    return align === "left" ? text + " ".repeat(pad) : " ".repeat(pad) + text;
}

/**
 * Cut an ANSI-colored string to a visible width, keeping the escape sequences.
 *
 * A prompt that redraws itself counts the lines it wrote. One line wider than the
 * terminal wraps into two, the count is then wrong, and the redraw clears the wrong
 * rows. So every line of such a prompt must pass through here first.
 */
export function truncateVisible(text: string, max: number): string {
    if (max <= 0) {
        return "";
    }

    if (visibleWidth(text) <= max) {
        return text;
    }

    const budget = max - 1;
    let out = "";
    let width = 0;
    let index = 0;

    while (index < text.length && width < budget) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code matching
        const ansi = /^\x1b\[[0-9;]*m/.exec(text.slice(index));

        if (ansi) {
            out += ansi[0];
            index += ansi[0].length;
            continue;
        }

        out += text[index];
        width += 1;
        index += 1;
    }

    // Reset, or the truncated cut leaves the rest of the line colored.
    return `${out}…\x1b[0m`;
}

export interface TableSelectColumn {
    label: string;
    align?: "left" | "right";
    /** Floor for the column width (visible chars); grows to fit cells. */
    minWidth?: number;
}

export interface TableSelectRow<T> {
    value: T;
    /** One ANSI-colored cell per column. */
    cells: string[];
    /** Single-glyph status badge shown left of the row (e.g. pc.green("●")). */
    badge?: string;
    /** Detail lines shown in the fixed-height zone while this row is focused. */
    detail?: string[];
    /** Cells to render while focused; defaults to accent() on the first cell. */
    cellsFocused?: string[];
}

export interface TableSelectOptions<T> {
    message: string;
    /** Dim suffix after the message, e.g. "(best first, % left)". */
    hint?: string;
    columns: TableSelectColumn[];
    rows: TableSelectRow<T>[];
    initialValue?: T;
    /** Rendered under the question after submit; defaults to String(value). */
    formatSubmitted?: (row: TableSelectRow<T>) => string;
}

interface FrameParts {
    widths: number[];
    rows: string[];
    rowsFocused: string[];
    details: string[][];
    detailHeight: number;
    detailWidth: number;
    hasBadges: boolean;
}

function columnWidths<T>(opts: TableSelectOptions<T>): number[] {
    return opts.columns.map((col, i) =>
        Math.max(
            col.minWidth ?? 0,
            visibleWidth(col.label),
            ...opts.rows.map((row) => visibleWidth(row.cells[i] ?? ""))
        )
    );
}

function renderCells<T>(opts: TableSelectOptions<T>, widths: number[], cells: string[]): string {
    return opts.columns.map((col, i) => padVisible(cells[i] ?? "", widths[i], col.align ?? "left")).join(GAP);
}

/** Pre-rendered static parts of the frame; only cursor/state vary per redraw. */
export function buildFrameParts<T>(opts: TableSelectOptions<T>): FrameParts {
    const widths = columnWidths(opts);
    const rows = opts.rows.map((row) => renderCells(opts, widths, row.cells));
    const rowsFocused = opts.rows.map((row) =>
        renderCells(opts, widths, row.cellsFocused ?? [accent(stripAnsi(row.cells[0] ?? "")), ...row.cells.slice(1)])
    );

    const details = opts.rows.map((row) => row.detail ?? []);
    const detailHeight = Math.max(0, ...details.map((d) => d.length));
    // Pad every block to the shared height so redraws never shrink or shift.
    for (const detail of details) {
        while (detail.length < detailHeight) {
            detail.push("");
        }
    }

    const detailWidth = Math.max(1, ...details.flat().map(visibleWidth));
    const hasBadges = opts.rows.some((row) => row.badge);
    return { widths, rows, rowsFocused, details, detailHeight, detailWidth, hasBadges };
}

export interface FrameSize {
    columns: number;
    rows: number;
}

/** The live terminal, with the defaults a pipe reports nothing for. */
export function terminalSize(): FrameSize {
    return { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

/** Which slice of the option list to draw, so `cursor` is always inside it. */
function windowAround(count: number, cursor: number, capacity: number): { start: number; end: number } {
    if (capacity >= count) {
        return { start: 0, end: count };
    }

    const start = Math.max(0, Math.min(cursor - Math.floor(capacity / 2), count - capacity));

    return { start, end: start + capacity };
}

/**
 * Pure frame renderer: question, fixed-height detail zone that follows the
 * focused row, header row, then aligned table rows (which never wrap or
 * move). Extracted from the prompt for testability.
 *
 * 🛑 Two hard limits, both about the redraw arithmetic. A prompt that redraws itself clears
 * the number of lines it wrote, so no line may WRAP (a wrapped line is two physical rows
 * counted as one) and the frame may never be TALLER than the screen (a scrolled frame cannot
 * be cleared). Breaking either leaves the old frame on screen with the new one stacked under
 * it: the arrow keys still work, but the copy the user is reading never changes, so the
 * prompt reads as frozen.
 *
 * Observed 2026-09-14 on `--resume dashboard`. The detail zone carries `Source file:` with a
 * whole absolute transcript path, which wraps on any terminal narrower than about 130 columns.
 * `search-multiselect.ts` clamped both limits already; this renderer clamped neither.
 */
export function renderFrame<T>(
    opts: TableSelectOptions<T>,
    parts: FrameParts,
    state: string,
    cursor: number,
    size: FrameSize = terminalSize()
): string {
    const { widths, rows, rowsFocused, details, detailHeight, detailWidth, hasBadges } = parts;
    const hint = opts.hint ? ` ${pc.dim(opts.hint)}` : "";
    const title = `${pc.gray("│")}\n${S_ACTIVE}  ${opts.message}${hint}`;
    const paint = (text: string) =>
        text
            .split("\n")
            .map((line) => truncateVisible(line, Math.max(1, size.columns - 1)))
            .join("\n");

    if (state === "submit") {
        const row = opts.rows[cursor];
        const submitted = opts.formatSubmitted
            ? opts.formatSubmitted(row)
            : stripAnsi(row.cells[0] ?? String(row.value));
        return paint(`${title.replace(S_ACTIVE, S_SUBMIT)}\n${BAR}  ${pc.dim(submitted)}`);
    }

    if (state === "cancel") {
        return paint(`${title.replace(S_ACTIVE, S_CANCEL)}\n${BAR}  ${pc.strikethrough(pc.dim("cancelled"))}`);
    }

    // Two title lines, the header row, and the closing bar.
    const chrome = 4;
    const budget = Math.max(4, size.rows - 1);
    // The option list is the point of the prompt, so the detail zone is what yields on a short
    // screen: a frame with nothing left to pick from is worse than one with no detail.
    let detailRows = detailHeight > 0 ? detailHeight + 1 : 0;

    if (budget - chrome - detailRows < 3) {
        detailRows = 0;
    }

    const capacity = Math.max(1, budget - chrome - detailRows);
    const hidden = capacity < opts.rows.length;
    const view = windowAround(opts.rows.length, cursor, hidden ? Math.max(1, capacity - 1) : capacity);
    const lines: string[] = [title];

    if (detailRows > 0) {
        const detail = details[cursor];
        for (const [i, line] of detail.entries()) {
            const gutter = i === 0 ? "┌" : i === detail.length - 1 ? "└" : "│";
            lines.push(`${BAR}  ${pc.gray(gutter)} ${padVisible(line, detailWidth)}`);
        }

        lines.push(BAR);
    }

    const rowPrefixWidth = hasBadges ? 4 : 2; // "❯ ● " vs "❯ "
    const header = opts.columns.map((col, i) => padVisible(col.label, widths[i], col.align ?? "left")).join(GAP);
    lines.push(`${BAR}  ${" ".repeat(rowPrefixWidth)}${pc.dim(header)}`);

    for (let i = view.start; i < view.end; i++) {
        const row = opts.rows[i];
        const focused = i === cursor;
        const pointer = focused ? pc.cyan("❯") : " ";
        const badge = hasBadges ? `${row.badge ?? " "} ` : "";
        lines.push(`${BAR}  ${pointer} ${badge}${focused ? rowsFocused[i] : rows[i]}`);
    }

    if (hidden) {
        const above = view.start;
        const below = opts.rows.length - view.end;
        const more = [above > 0 ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(Boolean);
        lines.push(`${BAR}  ${pc.dim(more.join("  "))}`);
    }

    lines.push(BAR_END);

    return paint(lines.join("\n"));
}

/**
 * Show the table select. Returns the picked row's value, or null on cancel.
 */
export async function tableSelect<T>(opts: TableSelectOptions<T>): Promise<T | null> {
    const parts = buildFrameParts(opts);

    const prompt = new SelectPrompt({
        options: opts.rows.map((row) => ({ value: row.value })),
        initialValue: opts.initialValue ?? opts.rows[0]?.value,
        render() {
            // Read the size per FRAME, never once up front: a resize mid-prompt is exactly
            // when a line that used to fit starts wrapping, which is what this guards.
            return renderFrame(opts, parts, this.state, this.cursor, terminalSize());
        },
    });

    const result = await prompt.prompt();

    if (isCancel(result)) {
        return null;
    }

    return result as T;
}
