import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { CACHE_DIR, cacheFilePath } from "./paths";
import { removeForDoctor } from "./remove";
import type { AnalyzerResult } from "./types";

interface CacheEntry {
    writtenAt: string;
    result: AnalyzerResult;
}

export async function readCache(analyzerId: string, ttlMs: number): Promise<AnalyzerResult | null> {
    const path = cacheFilePath(analyzerId);

    if (!existsSync(path)) {
        return null;
    }

    try {
        const raw = await readFile(path, "utf8");
        const parsed = SafeJSON.parse(raw, { strict: true }) as CacheEntry;
        const writtenAtMs = Date.parse(parsed.writtenAt);

        if (!Number.isFinite(writtenAtMs)) {
            return null;
        }

        const age = Date.now() - writtenAtMs;

        if (age > ttlMs) {
            return null;
        }

        return parsed.result;
    } catch {
        return null;
    }
}

export async function writeCache(analyzerId: string, result: AnalyzerResult): Promise<void> {
    const path = cacheFilePath(analyzerId);
    await mkdir(dirname(path), { recursive: true });
    const entry: CacheEntry = { writtenAt: result.timestamp, result };
    await writeFile(path, SafeJSON.stringify(entry), "utf8");
}

export async function wipeCache(): Promise<void> {
    if (!existsSync(CACHE_DIR)) {
        return;
    }

    const removal = await removeForDoctor(CACHE_DIR, { analyzerId: "cache" });

    if (removal.refusal) {
        throw new Error(`Refusing to wipe the doctor cache: ${removal.refusal}`);
    }
}
