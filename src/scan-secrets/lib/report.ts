import type { ScanResult } from "./types";

/** Plain, JSON-serializable view of a scan result (stable shape for `--json`). */
export function toJsonResult(result: ScanResult): ScanResult {
    return result;
}

function pad(value: string, width: number): string {
    return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * Human-readable report. Pure: returns a string; the entrypoint decides where
 * to write it. Findings are aligned `file:line  detector  masked`.
 */
export function formatHuman(result: ScanResult): string {
    const lines: string[] = [];

    for (const f of result.findings) {
        const loc = `${f.file}:${f.line}`;
        lines.push(`${pad(loc, 40)}${pad(f.detector, 22)}${f.masked}`);
    }

    const fileWord = result.findingCount === 1 ? "finding" : "findings";
    const distinctFiles = new Set(result.findings.map((f) => f.file)).size;
    const summary =
        result.findingCount === 0
            ? `0 findings (${result.scannedFiles} files scanned, ${result.skippedFiles} skipped)`
            : `${result.findingCount} ${fileWord} in ${distinctFiles} file${distinctFiles === 1 ? "" : "s"} ` +
              `(${result.scannedFiles} files scanned, ${result.skippedFiles} skipped)`;

    lines.push("");
    lines.push(summary);
    return lines.join("\n");
}
