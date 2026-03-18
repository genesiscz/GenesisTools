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

    // Match full-suite results: {suite}-{YYYY-MM-DD}.json or {suite}-{YYYY-MM-DD}-{sha7}.json
    const pattern = new RegExp(`^${suiteName}-\\d{4}-\\d{2}-\\d{2}(-[a-f0-9]{7})?\\.json$`);
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

/**
 * Find a saved result matching a git ref (SHA, branch, tag).
 * Resolves ref → full SHA, then searches result files for matching env.gitSha.
 */
export async function getBaselineResult(suiteName: string, ref: string): Promise<SavedResult | null> {
    ensureResultsDir();

    // Resolve ref to full SHA
    const proc = Bun.spawn(["git", "rev-parse", ref], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        return null;
    }

    const fullSha = (await new Response(proc.stdout).text()).trim();

    // Search all result files for this suite
    const prefix = `${suiteName}-`;
    const files = readdirSync(RESULTS_DIR)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
        .sort()
        .reverse();

    for (const file of files) {
        const content = await Bun.file(join(RESULTS_DIR, file)).text();
        const result = SafeJSON.parse(content) as SavedResult | null;

        if (result?.env?.gitSha === fullSha) {
            return result;
        }
    }

    // Fallback: try matching by short SHA prefix
    const sha7 = fullSha.slice(0, 7);

    for (const file of files) {
        const content = await Bun.file(join(RESULTS_DIR, file)).text();
        const result = SafeJSON.parse(content) as SavedResult | null;

        if (result?.env?.gitSha?.startsWith(sha7)) {
            return result;
        }
    }

    return null;
}
