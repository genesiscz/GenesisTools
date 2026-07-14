import { out } from "@app/logger";
import { formatBytes, formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@app/utils/table";
import pc from "picocolors";
import type { ScanResult } from "./types";

function shortName(fullPath: string): string {
    const last = fullPath.split("/").pop() ?? fullPath;
    const appMatch = fullPath.match(/\/([^/]+)\.app\//);

    if (appMatch && appMatch[1] !== last) {
        return `${appMatch[1]} (${last})`;
    }

    return last;
}

function colorSwap(bytes: number): string {
    const formatted = formatBytes(bytes);

    if (bytes >= 500 * 1024 ** 2) {
        return pc.red(pc.bold(formatted));
    }

    if (bytes >= 100 * 1024 ** 2) {
        return pc.yellow(formatted);
    }

    return pc.green(formatted);
}

function renderSummary(result: ScanResult): void {
    const { system, scannedCount, totalProcesses, processes } = result;
    const pctNum = system.totalBytes > 0 ? (system.usedBytes / system.totalBytes) * 100 : 0;
    const pct = pctNum.toFixed(1);
    const usedColor = pctNum >= 90 ? pc.red : pctNum >= 70 ? pc.yellow : pc.green;

    out.println(
        `  ${pc.dim("System swap")} ${usedColor(formatBytes(system.usedBytes))}${pc.dim(" / ")}${pc.white(formatBytes(system.totalBytes))} ${pc.dim(`(${pct}%)`)}`
    );
    const cacheNote =
        result.cacheHits > 0
            ? `${pc.dim("  ·  ")}${pc.white(String(result.freshScans))}${pc.dim(" fresh, ")}${pc.green(String(result.cacheHits))}${pc.dim(" cached")}`
            : "";
    const inaccessibleNote =
        result.inaccessibleCount > 0
            ? `${pc.dim("  ·  ")}${pc.yellow(String(result.inaccessibleCount))}${pc.dim(" inaccessible (root needed)")}`
            : "";

    out.println(
        `  ${pc.dim("Scanned")}     ${pc.white(String(scannedCount))}${pc.dim(" of ")}${pc.white(String(totalProcesses))}${pc.dim(" processes  ·  ")}${pc.white(String(processes.length))}${pc.dim(" with swap > 0")}${cacheNote}${inaccessibleNote}`
    );
    out.println();
}

export function renderResult(result: ScanResult, top: number): void {
    renderCliHeader("Swap Usage", "what's hogging your swap");
    renderSummary(result);

    const showAllHint = !result.wasAllMode;

    if (result.processes.length === 0) {
        out.println(pc.dim("  No processes with swap usage found among the scanned set.\n"));

        if (showAllHint) {
            out.println(pc.dim(`  Try ${pc.cyan("tools macos swap --all")} to scan every process (slow).\n`));
        }

        return;
    }

    const sorted = [...result.processes].sort((a, b) => b.swapBytes - a.swapBytes).slice(0, top);
    const table = createBoxTable(["PID", "PROCESS", "RSS", "SWAP", "UPTIME"]);

    for (const proc of sorted) {
        table.push([
            pc.dim(String(proc.pid)),
            pc.white(truncateDisplay(shortName(proc.name), 50)),
            pc.cyan(formatBytes(proc.rssBytes)),
            colorSwap(proc.swapBytes),
            pc.yellow(formatDuration(proc.uptimeMs, "ms", "hm-smart")),
        ]);
    }

    out.println(table.toString());
    out.println();

    const totalSwap = sorted.reduce((acc, p) => acc + p.swapBytes, 0);
    const trailing = showAllHint
        ? `${pc.dim("  ·  Run ")}${pc.cyan("tools macos swap --all")}${pc.dim(" to scan everything")}`
        : "";
    out.println(`${pc.dim(`  Top-${sorted.length} swap total: `)}${pc.white(formatBytes(totalSwap))}${trailing}`);
    out.println();
}

export function renderJson(result: ScanResult): void {
    const sorted = [...result.processes].sort((a, b) => b.swapBytes - a.swapBytes);
    process.stdout.write(SafeJSON.stringify({ ...result, processes: sorted }, null, 2));
    process.stdout.write("\n");
}
