import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { SavedResult } from "./types";

const RESULTS_DIR = join(homedir(), ".genesis-tools", "benchmarks");

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

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function getLastResult(suiteName: string): Promise<SavedResult | null> {
    ensureResultsDir();

    const escaped = escapeRegExp(suiteName);
    const pattern = new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
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

export function getAllResults(suiteName: string): string[] {
    ensureResultsDir();

    const escaped = escapeRegExp(suiteName);
    const pattern = new RegExp(`^${escaped}(-[a-zA-Z0-9_-]+)?-\\d{4}-\\d{2}-\\d{2}\\.json$`);
    return readdirSync(RESULTS_DIR)
        .filter((f) => pattern.test(f))
        .sort()
        .reverse();
}

export async function loadResult(filename: string): Promise<SavedResult> {
    const content = await Bun.file(join(RESULTS_DIR, filename)).text();
    return SafeJSON.parse(content) as SavedResult;
}
