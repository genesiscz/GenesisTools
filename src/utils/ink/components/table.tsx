/**
 * Table — Terminal-width-aware responsive table with Unicode box-drawing borders
 *
 * Uses useStdout() to detect terminal width and distributes column widths
 * proportionally. Long text wraps rather than truncating.
 */

import { Box, Text, useStdout } from "ink";
import React, { useMemo } from "react";

export interface Column {
    key: string;
    label: string;
    minWidth?: number;
    maxWidth?: number;
    align?: "left" | "right";
    color?: string;
}

export interface TableProps {
    columns: Column[];
    data: Record<string, string | number>[];
    borderColor?: string;
    emptyMessage?: string;
}

// ── Box-drawing characters ──────────────────────────────────────────────────

const BOX = {
    topLeft: "\u250C", // ┌
    topRight: "\u2510", // ┐
    bottomLeft: "\u2514", // └
    bottomRight: "\u2518", // ┘
    horizontal: "\u2500", // ─
    vertical: "\u2502", // │
    teeDown: "\u252C", // ┬
    teeUp: "\u2534", // ┴
    teeRight: "\u251C", // ├
    teeLeft: "\u2524", // ┤
    cross: "\u253C", // ┼
} as const;

// ── Width calculation ───────────────────────────────────────────────────────

function computeColumnWidths(columns: Column[], totalWidth: number): number[] {
    // Account for borders: │ col │ col │ = columns.length + 1 border chars + padding (1 each side per col)
    const borderChars = columns.length + 1;
    const paddingChars = columns.length * 2; // 1 space padding each side
    const available = Math.max(totalWidth - borderChars - paddingChars, columns.length);

    const minWidths = columns.map((col) => col.minWidth ?? 4);
    const maxWidths = columns.map((col) => col.maxWidth ?? Infinity);

    // Start with min widths
    const widths = [...minWidths];
    const consumed = widths.reduce((a, b) => a + b, 0);
    let remaining = available - consumed;

    if (remaining > 0) {
        // Distribute remaining space proportionally to columns that can grow
        const growable = columns.map((_, i) => i).filter((i) => widths[i]! < maxWidths[i]!);

        while (remaining > 0 && growable.length > 0) {
            const share = Math.max(1, Math.floor(remaining / growable.length));
            let distributed = false;

            for (let g = growable.length - 1; g >= 0; g--) {
                const i = growable[g]!;
                const canGrow = maxWidths[i]! - widths[i]!;
                const growth = Math.min(share, canGrow, remaining);

                if (growth > 0) {
                    widths[i]! += growth;
                    remaining -= growth;
                    distributed = true;
                }

                if (canGrow <= share) {
                    growable.splice(g, 1);
                }
            }

            if (!distributed) {
                break;
            }
        }
    }

    return widths;
}

// ── Cell formatting ─────────────────────────────────────────────────────────

function padCell(text: string, width: number, align: "left" | "right"): string {
    if (text.length >= width) {
        return text.slice(0, width);
    }
    const padding = width - text.length;
    if (align === "right") {
        return " ".repeat(padding) + text;
    }
    return text + " ".repeat(padding);
}

// ── Line builders ───────────────────────────────────────────────────────────

function buildHorizontalLine(widths: number[], left: string, middle: string, right: string): string {
    const segments = widths.map((w) => BOX.horizontal.repeat(w + 2));
    return left + segments.join(middle) + right;
}

// ── Component ───────────────────────────────────────────────────────────────

export function Table({ columns, data, borderColor = "gray", emptyMessage = "No data" }: TableProps) {
    const { stdout } = useStdout();
    const terminalWidth = stdout?.columns ?? 80;

    const widths = useMemo(() => computeColumnWidths(columns, terminalWidth), [columns, terminalWidth]);

    // Lines
    const topLine = buildHorizontalLine(widths, BOX.topLeft, BOX.teeDown, BOX.topRight);
    const separatorLine = buildHorizontalLine(widths, BOX.teeRight, BOX.cross, BOX.teeLeft);
    const bottomLine = buildHorizontalLine(widths, BOX.bottomLeft, BOX.teeUp, BOX.bottomRight);

    function renderRow(rowData: Record<string, string | number>, isHeader: boolean) {
        const cells = columns.map((col, i) => {
            const raw = isHeader ? col.label : String(rowData[col.key] ?? "");
            const cellText = padCell(raw, widths[i]!, col.align ?? "left");

            if (isHeader) {
                return (
                    <Text key={col.key} bold>
                        {" "}
                        {cellText}{" "}
                    </Text>
                );
            }

            return (
                <Text key={col.key} color={col.color} wrap="wrap">
                    {" "}
                    {cellText}{" "}
                </Text>
            );
        });

        return (
            <Box key={isHeader ? "__header" : undefined}>
                <Text color={borderColor}>{BOX.vertical}</Text>
                {cells.map((cell, i) => (
                    <React.Fragment key={columns[i]!.key}>
                        {cell}
                        <Text color={borderColor}>{BOX.vertical}</Text>
                    </React.Fragment>
                ))}
            </Box>
        );
    }

    if (data.length === 0) {
        const innerWidth = terminalWidth - 2;
        const msg = emptyMessage;
        const padLeft = Math.max(0, Math.floor((innerWidth - msg.length) / 2));
        const padRight = Math.max(0, innerWidth - msg.length - padLeft);

        return (
            <Box flexDirection="column">
                <Text color={borderColor}>{topLine}</Text>
                <Box>
                    <Text color={borderColor}>{BOX.vertical}</Text>
                    <Text dimColor>
                        {" ".repeat(padLeft)}
                        {msg}
                        {" ".repeat(padRight)}
                    </Text>
                    <Text color={borderColor}>{BOX.vertical}</Text>
                </Box>
                <Text color={borderColor}>{bottomLine}</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Text color={borderColor}>{topLine}</Text>
            {renderRow({}, true)}
            <Text color={borderColor}>{separatorLine}</Text>
            {data.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                <React.Fragment key={i}>{renderRow(row, false)}</React.Fragment>
            ))}
            <Text color={borderColor}>{bottomLine}</Text>
        </Box>
    );
}
