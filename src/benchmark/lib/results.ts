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
    ensureResultsDir();

    const date = new Date().toISOString().slice(0, 10);
    const suffix = label ? `-${sanitizeFilename(label)}` : "";
    return join(RESULTS_DIR, `${suiteName}${suffix}-${date}.json`);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildResultPattern(suiteName: string, label?: string): RegExp {
    const escaped = escapeRegExp(suiteName);
    const labelPart = label ? `-${escapeRegExp(sanitizeFilename(label))}` : "(-[a-zA-Z0-9_-]+)?";
    return new RegExp(`^${escaped}${labelPart}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
}

function sortByDate(files: string[]): string[] {
    const datePattern = /(\d{4}-\d{2}-\d{2})\.json$/;
    return [...files].sort((a, b) => {
        const dateA = a.match(datePattern)?.[1] ?? "";
        const dateB = b.match(datePattern)?.[1] ?? "";
        return dateB.localeCompare(dateA);
    });
}

export async function getLastResult(suiteName: string, label?: string): Promise<SavedResult | null> {
    ensureResultsDir();

    const pattern = buildResultPattern(suiteName, label);
    const files = sortByDate(readdirSync(RESULTS_DIR).filter((f) => pattern.test(f)));

    if (files.length === 0) {
        return null;
    }

    try {
        const content = await Bun.file(join(RESULTS_DIR, files[0])).text();
        return SafeJSON.parse(content, { strict: true }) as SavedResult;
    } catch {
        return null;
    }
}

export function getAllResults(suiteName: string): string[] {
    ensureResultsDir();

    const pattern = buildResultPattern(suiteName);
    return sortByDate(readdirSync(RESULTS_DIR).filter((f) => pattern.test(f)));
}

export async function loadResult(filename: string): Promise<SavedResult> {
    const content = await Bun.file(join(RESULTS_DIR, filename)).text();
    return SafeJSON.parse(content, { strict: true }) as SavedResult;
}
