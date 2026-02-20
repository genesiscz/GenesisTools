export interface TableOptions {
    alignRight?: number[]; // column indices to right-align
    maxColWidth?: number; // max column width before truncation (default: 50)
}

function truncateCell(value: string, maxWidth: number): string {
    if (value.length <= maxWidth) return value;
    return `${value.slice(0, maxWidth - 3)}...`;
}

export function formatTable(rows: string[][], headers: string[], options?: TableOptions): string {
    const maxColWidth = options?.maxColWidth ?? 50;
    const alignRight = new Set(options?.alignRight ?? []);

    // Calculate column widths from headers and all row values
    const colWidths = headers.map((h) => Math.min(h.length, maxColWidth));
    for (const row of rows) {
        for (let i = 0; i < row.length; i++) {
            const cellLen = Math.min(row[i].length, maxColWidth);
            if (colWidths[i] === undefined || cellLen > colWidths[i]) {
                colWidths[i] = cellLen;
            }
        }
    }

    function padCell(value: string, colIndex: number): string {
        const truncated = truncateCell(value, maxColWidth);
        const width = colWidths[colIndex];
        if (alignRight.has(colIndex)) {
            return truncated.padStart(width);
        }
        return truncated.padEnd(width);
    }

    // Build header row
    const headerLine = headers.map((h, i) => padCell(h, i)).join("  ");

    // Build separator line
    const separatorLine = colWidths.map((w) => "─".repeat(w)).join("  ");

    // Build data rows
    const dataLines = rows.map((row) => row.map((cell, i) => padCell(cell, i)).join("  "));

    return [headerLine, separatorLine, ...dataLines].join("\n");
}
