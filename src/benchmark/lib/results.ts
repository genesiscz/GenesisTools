import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { SavedResult } from "@app/benchmark/types";

export const RESULTS_DIR = join(homedir(), ".genesis-tools", "benchmarks");

export function ensureResultsDir(): void {
    if (!existsSync(RESULTS_DIR)) {
        mkdirSync(RESULTS_DIR, { recursive: true });
    }
}

function sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getResultPath(suiteName: string, label?: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const suffix = label ? `-${sanitizeFilename(label)}` : "";
    return join(RESULTS_DIR, `${suiteName}${suffix}-${date}.json`);
}

export async function getLastResult(suiteName: string): Promise<SavedResult | null> {
    ensureResultsDir();

    // Match only full-suite results: {suite}-{YYYY-MM-DD}.json
    // Exclude --only partial results: {suite}-{label}-{YYYY-MM-DD}.json
    const pattern = new RegExp(`^${suiteName}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
    const files = readdirSync(RESULTS_DIR)
        .filter((f) => pattern.test(f))
        .sort()
        .reverse();

    if (files.length === 0) {
        return null;
    }

    const content = await Bun.file(join(RESULTS_DIR, files[0])).text();
    return SafeJSON.parse(content) as SavedResult;
}
