import { formatBytes, formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import Table from "cli-table3";
import pc from "picocolors";
import type { ScanResult } from "./types";

const HEADER_TEXT_MAX_WIDTH = 31;

function truncate(value: string, max: number): string {
    if (value.length <= max) {
        return value;
    }

    return `${value.slice(0, max - 1)}…`;
}

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

function renderHeader(): void {
    const border = pc.cyan(pc.bold(" │"));
    const title = "Swap Usage";
    const subtitle = "what's hogging your swap";
    console.log();
    console.log(pc.cyan(pc.bold(" ┌─────────────────────────────────────┐")));
    console.log(`${border}${pc.white(pc.bold(`  ${title.padEnd(HEADER_TEXT_MAX_WIDTH)}`))}${pc.cyan(pc.bold("│"))}`);
    console.log(`${border}${pc.dim(`  ${subtitle.padEnd(HEADER_TEXT_MAX_WIDTH)}`)}${pc.cyan(pc.bold("│"))}`);
    console.log(pc.cyan(pc.bold(" └─────────────────────────────────────┘")));
    console.log();
}

function renderSummary(result: ScanResult): void {
    const { system, scannedCount, totalProcesses, processes } = result;
    const pctNum = system.totalBytes > 0 ? (system.usedBytes / system.totalBytes) * 100 : 0;
    const pct = pctNum.toFixed(1);
    const usedColor = pctNum >= 90 ? pc.red : pctNum >= 70 ? pc.yellow : pc.green;

    console.log(
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

    console.log(
        `  ${pc.dim("Scanned")}     ${pc.white(String(scannedCount))}${pc.dim(" of ")}${pc.white(String(totalProcesses))}${pc.dim(" processes  ·  ")}${pc.white(String(processes.length))}${pc.dim(" with swap > 0")}${cacheNote}${inaccessibleNote}`
    );
    console.log();
}

function createTable(): Table.Table {
    return new Table({
        chars: {
            top: "─",
            "top-mid": "┬",
            "top-left": "┌",
            "top-right": "┐",
            bottom: "─",
            "bottom-mid": "┴",
            "bottom-left": "└",
            "bottom-right": "┘",
            left: "│",
            "left-mid": "├",
            mid: "─",
            "mid-mid": "┼",
            right: "│",
            "right-mid": "┤",
            middle: "│",
        },
        head: ["PID", "PROCESS", "RSS", "SWAP", "UPTIME"].map((h) => pc.cyan(pc.bold(h))),
        style: { head: [], border: ["gray"], "padding-left": 1, "padding-right": 1 },
    });
}

export function renderResult(result: ScanResult, top: number): void {
    renderHeader();
    renderSummary(result);

    const showAllHint = !result.wasAllMode;

    if (result.processes.length === 0) {
        console.log(pc.dim("  No processes with swap usage found among the scanned set.\n"));

        if (showAllHint) {
            console.log(pc.dim(`  Try ${pc.cyan("tools macos swap --all")} to scan every process (slow).\n`));
        }

        return;
    }

    const sorted = [...result.processes].sort((a, b) => b.swapBytes - a.swapBytes).slice(0, top);
    const table = createTable();

    for (const proc of sorted) {
        table.push([
            pc.dim(String(proc.pid)),
            pc.white(truncate(shortName(proc.name), 50)),
            pc.cyan(formatBytes(proc.rssBytes)),
            colorSwap(proc.swapBytes),
            pc.yellow(formatDuration(proc.uptimeMs, "ms", "hm-smart")),
        ]);
    }

    console.log(table.toString());
    console.log();

    const totalSwap = sorted.reduce((acc, p) => acc + p.swapBytes, 0);
    const trailing = showAllHint
        ? `${pc.dim("  ·  Run ")}${pc.cyan("tools macos swap --all")}${pc.dim(" to scan everything")}`
        : "";
    console.log(`${pc.dim(`  Top-${sorted.length} swap total: `)}${pc.white(formatBytes(totalSwap))}${trailing}`);
    console.log();
}

export function renderJson(result: ScanResult): void {
    const sorted = [...result.processes].sort((a, b) => b.swapBytes - a.swapBytes);
    process.stdout.write(SafeJSON.stringify({ ...result, processes: sorted }, null, 2));
    process.stdout.write("\n");
}
