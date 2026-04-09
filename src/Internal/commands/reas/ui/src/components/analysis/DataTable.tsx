import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { type DataTablePrimitive, sortDataTableRows } from "./shared";

type DataTableAlign = "left" | "right";

export interface DataTableColumn<Row extends Record<string, ReactNode>> {
    key: keyof Row | string;
    header: string;
    align?: DataTableAlign;
    className?: string;
    render?: (row: Row) => ReactNode;
    sortValue?: (row: Row) => DataTablePrimitive;
}

export interface DataTableSort<Row extends Record<string, ReactNode>> {
    key: keyof Row | string;
    direction: "asc" | "desc";
}

interface DataTableProps<Row extends Record<string, ReactNode>> {
    columns: DataTableColumn<Row>[];
    rows: Row[];
    getRowKey: (row: Row, index: number) => string;
    initialSort?: DataTableSort<Row>;
    emptyMessage?: string;
    rowClassName?: (row: Row) => string | undefined;
}

export function DataTable<Row extends Record<string, ReactNode>>({
    columns,
    rows,
    getRowKey,
    initialSort,
    emptyMessage = "No rows available.",
    rowClassName,
}: DataTableProps<Row>) {
    const sortedRows = useMemo(() => {
        if (!initialSort) {
            return rows;
        }

        const column = columns.find((item) => item.key === initialSort.key);

        if (!column) {
            return rows;
        }

        return sortDataTableRows({
            rows,
            direction: initialSort.direction,
            getValue: (row) => readSortValue({ row, column, key: initialSort.key }),
        });
    }, [columns, initialSort, rows]);

    return (
        <div className="overflow-x-auto">
            <Table>
                <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                        {columns.map((column) => (
                            <TableHead
                                key={String(column.key)}
                                className={cn(
                                    "font-mono text-[10px] uppercase tracking-[0.22em] text-slate-500",
                                    column.align === "right" ? "text-right" : undefined,
                                    column.className
                                )}
                            >
                                {column.header}
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {sortedRows.length > 0 ? (
                        sortedRows.map((row, index) => (
                            <TableRow
                                key={getRowKey(row, index)}
                                className={cn("border-white/5 hover:bg-white/[0.03]", rowClassName?.(row))}
                            >
                                {columns.map((column) => (
                                    <TableCell
                                        key={String(column.key)}
                                        className={cn(
                                            "font-mono text-xs text-slate-300",
                                            column.align === "right" ? "text-right" : undefined,
                                            column.className
                                        )}
                                    >
                                        {column.render ? column.render(row) : row[column.key as keyof Row]}
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))
                    ) : (
                        <TableRow className="border-white/5 hover:bg-transparent">
                            <TableCell
                                colSpan={columns.length}
                                className="py-8 text-center font-mono text-xs text-slate-500"
                            >
                                {emptyMessage}
                            </TableCell>
                        </TableRow>
                    )}
                </TableBody>
            </Table>
        </div>
    );
}

function readSortValue<Row extends Record<string, ReactNode>>({
    row,
    column,
    key,
}: {
    row: Row;
    column: DataTableColumn<Row>;
    key: keyof Row | string;
}): DataTablePrimitive {
    if (column.sortValue) {
        return column.sortValue(row);
    }

    const value = row[key as keyof Row];

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) {
        return value;
    }

    return String(value);
}
