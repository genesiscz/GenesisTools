import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button, parseNumberDraft } from "./forms";
import { moveItem } from "./sortable";

/**
 * A table whose cells are inputs. Every cell keeps a draft while it has focus
 * and commits on blur or Enter, so Escape can put the value back without the
 * caller ever seeing the half-typed one. Rows are plain records, like
 * DataTable, and every change hands the caller a NEW array.
 */

export type EditableValue = string | number | null;
export type EditableRow = Record<string, EditableValue>;

export interface EditableColumn {
    key: string;
    label: string;
    /** Default "text". */
    type?: "text" | "number" | "date" | "select";
    options?: Array<{ value: string; label: string }>;
    min?: number | string;
    max?: number | string;
    step?: number;
    mono?: boolean;
    required?: boolean;
    /** Return an error message, or undefined when the cell is valid. */
    validate?: (value: EditableValue, row: EditableRow, rows: EditableRow[]) => string | undefined;
    /** A computed, read-only cell (a duration from two dates). */
    render?: (row: EditableRow, index: number) => ReactNode;
    /** Footer aggregate. */
    total?: "sum" | "count" | ((rows: EditableRow[]) => ReactNode);
}

export interface EditableChange {
    type: "edit" | "add" | "remove" | "move";
    index: number;
    key?: string;
}

export interface EditableTableProps {
    columns: EditableColumn[];
    rows: EditableRow[];
    onChange: (rows: EditableRow[], change: EditableChange) => void;
    /** Stable id per row. Default: the index. */
    rowKey?: (row: EditableRow, index: number) => string;
    /** Makes the "Add row" button appear. */
    newRow?: () => EditableRow;
    canRemove?: boolean | ((row: EditableRow) => boolean);
    /** Add Move up and Move down buttons per row. */
    reorder?: boolean;
    caption?: string;
    emptyText?: string;
}

/** The problem with one cell, or undefined. `required` comes first, then the column's own check. */
export function editableCellError(column: EditableColumn, row: EditableRow, rows: EditableRow[]): string | undefined {
    if (column.render) {
        return undefined;
    }

    const value = row[column.key] ?? null;

    if (column.required && (value === null || value === "")) {
        return `${column.label} is required`;
    }

    return column.validate?.(value, row, rows);
}

/** Footer value of one column. "sum" adds the numeric cells and skips nulls. */
export function editableTotal(column: EditableColumn, rows: EditableRow[]): ReactNode {
    if (!column.total) {
        return null;
    }

    if (column.total === "count") {
        return rows.length;
    }

    if (column.total === "sum") {
        const sum = rows.reduce((acc, row) => {
            const value = row[column.key];

            return acc + (typeof value === "number" ? value : 0);
        }, 0);

        return Math.round(sum * 1000) / 1000;
    }

    return column.total(rows);
}

/** Check a date draft against the column bounds. Returns an error message or undefined. */
function dateBoundsError(column: EditableColumn, value: string): string | undefined {
    if (!value) {
        return undefined;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return `${column.label} must be a date (YYYY-MM-DD)`;
    }

    if (typeof column.min === "string" && value < column.min) {
        return `${column.label} must be on or after ${column.min}`;
    }

    if (typeof column.max === "string" && value > column.max) {
        return `${column.label} must be on or before ${column.max}`;
    }

    return undefined;
}

const CELL_INPUT =
    "h-8 w-full rounded-[6px] border border-transparent bg-transparent px-2 text-sm text-ink hover:border-line focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-info";

interface CellProps {
    column: EditableColumn;
    value: EditableValue;
    rowIndex: number;
    colIndex: number;
    error?: string;
    onCommit: (value: EditableValue) => void;
    onReject: (message: string) => void;
    onEnter: () => void;
}

function toText(value: EditableValue): string {
    return value === null ? "" : String(value);
}

function EditCell({ column, value, rowIndex, colIndex, error, onCommit, onReject, onEnter }: CellProps) {
    const [draft, setDraft] = useState<string | null>(null);
    const type = column.type ?? "text";
    const numeric = type === "number";
    const label = `${column.label}, row ${rowIndex + 1}`;
    const shown = draft ?? toText(value);

    const commit = (text: string | null): void => {
        setDraft(null);

        if (text === null) {
            return;
        }

        let next: EditableValue = text;

        if (numeric) {
            const parsed = parseNumberDraft(text);

            if (parsed === undefined) {
                onReject(`${column.label} must be a number`);

                return;
            }

            next = parsed;
        } else if (type === "date") {
            const problem = dateBoundsError(column, text);

            if (problem) {
                onReject(problem);

                return;
            }

            next = text === "" ? null : text;
        }

        if (next !== value) {
            onCommit(next);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
        } else if (event.key === "Enter") {
            event.preventDefault();
            commit(draft);
            onEnter();
        }
    };

    const common = {
        "aria-label": label,
        "aria-invalid": error ? true : undefined,
        title: error,
        "data-cell": `${rowIndex}:${colIndex}`,
        onKeyDown,
    };
    const invalid = error ? "border-err hover:border-err" : "";

    if (type === "select") {
        return (
            <select
                {...common}
                value={toText(value)}
                onChange={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
                className={`${CELL_INPUT} ${invalid}`}
            >
                <option value="">Choose</option>
                {column.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        );
    }

    return (
        <input
            {...common}
            type={type === "date" ? "date" : "text"}
            inputMode={numeric ? "decimal" : undefined}
            min={type === "date" && typeof column.min === "string" ? column.min : undefined}
            max={type === "date" && typeof column.max === "string" ? column.max : undefined}
            value={shown}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            className={`${CELL_INPUT} ${invalid} ${numeric || column.mono ? "font-mono tabular-nums" : ""} ${numeric ? "text-right" : ""}`}
        />
    );
}

/** Data table with input cells, add and remove, validation and totals. Non-generic, like DataTable. */
export function EditableTable({
    columns,
    rows,
    onChange,
    rowKey,
    newRow,
    canRemove = true,
    reorder = false,
    caption,
    emptyText = "No rows yet.",
}: EditableTableProps) {
    const tableRef = useRef<HTMLTableElement>(null);
    const [announce, setAnnounce] = useState("");
    const [focusRow, setFocusRow] = useState<number | null>(null);

    useEffect(() => {
        if (focusRow === null) {
            return;
        }

        tableRef.current?.querySelector<HTMLElement>(`[data-cell^="${focusRow}:"]`)?.focus();
        setFocusRow(null);
    }, [focusRow]);

    const errors = rows.map((row) => columns.map((column) => editableCellError(column, row, rows)));
    const problems = errors.flat().filter(Boolean).length;
    const hasTotals = columns.some((c) => c.total);
    const removable = (row: EditableRow): boolean => (typeof canRemove === "function" ? canRemove(row) : canRemove);
    const showRemove = canRemove !== false;

    const edit = (index: number, key: string, value: EditableValue): void => {
        const next = rows.map((row, i) => (i === index ? { ...row, [key]: value } : row));
        onChange(next, { type: "edit", index, key });
    };

    const add = (): void => {
        if (!newRow) {
            return;
        }

        const next = [...rows, newRow()];
        onChange(next, { type: "add", index: rows.length });
        setAnnounce(`Row ${next.length} added`);
        setFocusRow(rows.length);
    };

    const remove = (index: number): void => {
        onChange(
            rows.filter((_, i) => i !== index),
            { type: "remove", index }
        );
        setAnnounce(`Row ${index + 1} removed`);
    };

    const move = (index: number, to: number): void => {
        onChange(moveItem(rows, index, to), { type: "move", index });
        setAnnounce(`Row ${index + 1} moved to position ${to + 1}`);
    };

    const focusBelow = (rowIndex: number, colIndex: number): void => {
        tableRef.current?.querySelector<HTMLElement>(`[data-cell="${rowIndex + 1}:${colIndex}"]`)?.focus();
    };

    const iconButton =
        "rounded px-1.5 py-0.5 text-xs text-dim hover:bg-canvas hover:text-ink disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info";

    return (
        <div className="my-3">
            <div className="overflow-x-auto rounded-card border border-line">
                <table ref={tableRef} className="w-full text-sm">
                    {caption ? <caption className="p-2 text-left text-xs text-dim">{caption}</caption> : null}
                    <thead>
                        <tr className="bg-panel text-left text-xs text-dim">
                            {reorder ? (
                                <th scope="col" className="w-16 px-2 py-2 font-semibold">
                                    <span className="sr-only">Order</span>
                                </th>
                            ) : null}
                            {columns.map((c) => (
                                <th
                                    key={c.key}
                                    scope="col"
                                    className={`px-3 py-2 font-semibold ${c.type === "number" ? "text-right" : ""}`}
                                >
                                    {c.label}
                                    {c.required ? (
                                        <span aria-hidden="true" className="ml-0.5 text-err">
                                            *
                                        </span>
                                    ) : null}
                                </th>
                            ))}
                            {showRemove ? (
                                <th scope="col" className="w-10 px-2 py-2">
                                    <span className="sr-only">Remove</span>
                                </th>
                            ) : null}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={columns.length + (reorder ? 1 : 0) + (showRemove ? 1 : 0)}
                                    className="px-3 py-4 text-center text-dim"
                                >
                                    {emptyText}
                                </td>
                            </tr>
                        ) : null}
                        {rows.map((row, r) => (
                            <tr key={rowKey ? rowKey(row, r) : r} className="border-t border-line/70">
                                {reorder ? (
                                    <td className="px-1 py-1 whitespace-nowrap">
                                        <button
                                            type="button"
                                            className={iconButton}
                                            disabled={r === 0}
                                            aria-label={`Move row ${r + 1} up`}
                                            onClick={() => move(r, r - 1)}
                                        >
                                            ↑
                                        </button>
                                        <button
                                            type="button"
                                            className={iconButton}
                                            disabled={r === rows.length - 1}
                                            aria-label={`Move row ${r + 1} down`}
                                            onClick={() => move(r, r + 1)}
                                        >
                                            ↓
                                        </button>
                                    </td>
                                ) : null}
                                {columns.map((c, ci) => (
                                    <td
                                        key={c.key}
                                        className={`px-1 py-1 align-middle ${c.render && c.type === "number" ? "text-right" : ""}`}
                                    >
                                        {c.render ? (
                                            <span className="block px-2 font-mono text-[0.82rem] text-dim tabular-nums">
                                                {c.render(row, r)}
                                            </span>
                                        ) : (
                                            <EditCell
                                                column={c}
                                                value={row[c.key] ?? null}
                                                rowIndex={r}
                                                colIndex={ci}
                                                error={errors[r][ci]}
                                                onCommit={(value) => edit(r, c.key, value)}
                                                onReject={setAnnounce}
                                                onEnter={() => focusBelow(r, ci)}
                                            />
                                        )}
                                    </td>
                                ))}
                                {showRemove ? (
                                    <td className="px-1 py-1 text-center">
                                        <button
                                            type="button"
                                            className={iconButton}
                                            disabled={!removable(row)}
                                            aria-label={`Remove row ${r + 1}`}
                                            onClick={() => remove(r)}
                                        >
                                            ✕
                                        </button>
                                    </td>
                                ) : null}
                            </tr>
                        ))}
                    </tbody>
                    {hasTotals && rows.length > 0 ? (
                        <tfoot>
                            <tr className="border-t border-line bg-panel/60 font-semibold">
                                {reorder ? <td /> : null}
                                {columns.map((c, ci) => (
                                    <td
                                        key={c.key}
                                        data-total={c.key}
                                        className={`px-3 py-1.5 ${c.type === "number" ? "text-right font-mono tabular-nums" : ""}`}
                                    >
                                        {ci === 0 && !c.total ? "Total" : editableTotal(c, rows)}
                                    </td>
                                ))}
                                {showRemove ? <td /> : null}
                            </tr>
                        </tfoot>
                    ) : null}
                </table>
            </div>
            <div className="mt-2 flex items-center gap-3">
                {newRow ? (
                    <Button variant="ghost" size="sm" onClick={add}>
                        + Add row
                    </Button>
                ) : null}
                {problems > 0 ? (
                    <span className="text-xs text-err" data-editable-problems="">
                        {problems === 1 ? "1 cell needs attention" : `${problems} cells need attention`}
                    </span>
                ) : null}
            </div>
            <div aria-live="polite" className="sr-only" data-editable-live="">
                {announce}
            </div>
        </div>
    );
}
