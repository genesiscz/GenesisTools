import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { analysisDirFor, HISTORY_FILE } from "./paths";
import type { ActionResult, AnalyzerResult } from "./types";

export interface HistoryEntry {
    timestamp: string;
    runId: string;
    action: ActionResult;
}

export interface RunSummary {
    startedAt: string;
    endedAt: string;
    analyzers: string[];
    totalReclaimedBytes: number;
}

export async function appendHistory(runId: string, action: ActionResult): Promise<void> {
    await mkdir(dirname(HISTORY_FILE), { recursive: true });
    const entry: HistoryEntry = { timestamp: new Date().toISOString(), runId, action };
    await appendFile(HISTORY_FILE, `${SafeJSON.stringify(entry)}\n`, "utf8");
}

export async function readHistorySince(since: Date): Promise<HistoryEntry[]> {
    if (!existsSync(HISTORY_FILE)) {
        return [];
    }

    const raw = await readFile(HISTORY_FILE, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const entries: HistoryEntry[] = [];

    for (const line of lines) {
        try {
            const parsed = SafeJSON.parse(line, { strict: true }) as HistoryEntry;

            if (new Date(parsed.timestamp) >= since) {
                entries.push(parsed);
            }
        } catch (err) {
            console.error("Failed to parse history line", err);
        }
    }

    return entries;
}

export async function writeAnalysisLog(runId: string, analyzerId: string, result: AnalyzerResult): Promise<void> {
    const dir = analysisDirFor(runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${analyzerId}.json`), SafeJSON.stringify(result, null, 2), "utf8");
}

export async function writeRunSummary(runId: string, summary: RunSummary): Promise<void> {
    const dir = analysisDirFor(runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), SafeJSON.stringify(summary, null, 2), "utf8");
}
