import { formatTable } from "@app/utils/table";
import type { ScanResult } from "./types";

/** Plain, JSON-serializable view of a scan result (stable shape for `--json`). */
export function toJsonResult(result: ScanResult): ScanResult {
    return result;
}

/** Wide enough that real `path:line` locations are never truncated. */
const MAX_COL_WIDTH = 120;

/**
 * Human-readable report. Pure: returns a string; the entrypoint decides where
 * to write it. Findings are rendered as an aligned `LOCATION / DETECTOR /
 * SECRET` table via the shared `formatTable`, so columns never collide.
 */
export function formatHuman(result: ScanResult): string {
    const lines: string[] = [];

    if (result.findings.length > 0) {
        const rows = result.findings.map((f) => [`${f.file}:${f.line}`, f.detector, f.masked]);
        lines.push(formatTable(rows, ["LOCATION", "DETECTOR", "SECRET"], { maxColWidth: MAX_COL_WIDTH }));
        lines.push("");
    }

    const fileWord = result.findingCount === 1 ? "finding" : "findings";
    const distinctFiles = new Set(result.findings.map((f) => f.file)).size;
    const summary =
        result.findingCount === 0
            ? `0 findings (${result.scannedFiles} files scanned, ${result.skippedFiles} skipped)`
            : `${result.findingCount} ${fileWord} in ${distinctFiles} file${distinctFiles === 1 ? "" : "s"} ` +
              `(${result.scannedFiles} files scanned, ${result.skippedFiles} skipped)`;

    lines.push(summary);
    return lines.join("\n");
}
