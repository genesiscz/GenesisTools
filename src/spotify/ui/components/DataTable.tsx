/**
 * The paginated table every ranking uses.
 *
 * The API hands back the FULL ranking (the CLI's `--csv` needs it anyway), so paging and
 * filtering happen here with no extra round trips. A `bar` column renders a proportional
 * fill instead of a number, which is what makes a ranking readable at a glance.
 */
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

export interface Column<T> {
    key: string;
    header: string;
    /** Right-align numeric columns. */
    align?: "left" | "right";
    width?: string;
    render: (row: T, index: number) => ReactNode;
    /** Value used by the search box; omit to exclude the column from search. */
    search?: (row: T) => string;
}

export interface DataTableProps<T> {
    rows: T[];
    columns: Column<T>[];
    rowKey: (row: T, index: number) => string;
    pageSize?: number;
    /** Shows a search box filtering on every column that declares `search`. */
    searchable?: boolean;
    searchPlaceholder?: string;
    empty?: string;
    /** Rendered under the table, e.g. a coverage note. */
    footer?: ReactNode;
}

export function DataTable<T>({
    rows,
    columns,
    rowKey,
    pageSize = 25,
    searchable = false,
    searchPlaceholder = "Filter…",
    empty = "No rows.",
    footer,
}: DataTableProps<T>) {
    const [page, setPage] = useState(0);
    const [term, setTerm] = useState("");

    const filtered = useMemo(() => {
        const q = term.trim().toLowerCase();
        if (!q) {
            return rows;
        }

        const searchers = columns.filter((c) => c.search).map((c) => c.search!);

        return rows.filter((row) => searchers.some((get) => get(row).toLowerCase().includes(q)));
    }, [rows, columns, term]);

    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const current = Math.min(page, pageCount - 1);
    const slice = filtered.slice(current * pageSize, current * pageSize + pageSize);

    return (
        <Card variant="wow-static" className="p-0 overflow-hidden">
            {searchable && (
                <div className="p-3 border-b border-border/60 flex items-center gap-2">
                    <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <Input
                        value={term}
                        onChange={(e) => {
                            setTerm(e.target.value);
                            setPage(0);
                        }}
                        placeholder={searchPlaceholder}
                        aria-label={searchPlaceholder}
                        className="h-8 text-xs"
                    />
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border/60">
                            {columns.map((c) => (
                                <th
                                    key={c.key}
                                    style={c.width ? { width: c.width } : undefined}
                                    className={cn(
                                        "px-3 py-2 text-[11px] font-mono uppercase tracking-widest text-muted-foreground",
                                        c.align === "right" ? "text-right" : "text-left"
                                    )}
                                >
                                    {c.header}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {slice.length === 0 && (
                            <tr>
                                <td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">
                                    {empty}
                                </td>
                            </tr>
                        )}
                        {slice.map((row, i) => (
                            <tr
                                key={rowKey(row, current * pageSize + i)}
                                className="border-b border-border/30 hover:bg-primary/5"
                            >
                                {columns.map((c) => (
                                    <td
                                        key={c.key}
                                        className={cn(
                                            "px-3 py-1.5 align-middle",
                                            c.align === "right" ? "text-right tabular-nums" : "text-left"
                                        )}
                                    >
                                        {c.render(row, current * pageSize + i)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="flex items-center justify-between gap-3 p-3 border-t border-border/60">
                <div className="text-xs text-muted-foreground font-mono">
                    {filtered.length.toLocaleString("en-US")} rows
                    {filtered.length !== rows.length && ` of ${rows.length.toLocaleString("en-US")}`}
                </div>
                {pageCount > 1 && (
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={current === 0}
                            onClick={() => setPage(current - 1)}
                            aria-label="Previous page"
                        >
                            <ChevronLeft className="h-3.5 w-3.5" />
                        </Button>
                        <span className="text-xs font-mono text-muted-foreground">
                            {current + 1} / {pageCount}
                        </span>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={current >= pageCount - 1}
                            onClick={() => setPage(current + 1)}
                            aria-label="Next page"
                        >
                            <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                )}
            </div>

            {footer && <div className="px-3 pb-3 text-xs text-muted-foreground">{footer}</div>}
        </Card>
    );
}

/** Proportional fill used as a table cell — the dashboard's answer to the terminal bar. */
export function BarCell({ value, max, color = "var(--chart-1)" }: { value: number; max: number; color?: string }) {
    const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

    return (
        <div className="h-2 w-full min-w-16 rounded-full bg-muted/40 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: color }} />
        </div>
    );
}
