import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
// Imported from the leaf module, not from `@genesiscz/utils/profile`: the
// profiler imports this file back, and the barrel would close that loop.
import type { ProfilingDetail } from "@genesiscz/utils/profile/scopes";
import { Storage } from "@genesiscz/utils/storage";

const storage = new Storage("GenesisTools");

export type { ProfilingDetail };

export interface ProfilingConfig {
    enabled: boolean;
    scopes: string[];
    stderr: boolean;
    file: boolean;
    filePath: string | null;
    minDurationMs: number;
    summaryOnExit: boolean;
    detail: ProfilingDetail;
}

export const DEFAULT_PROFILING: ProfilingConfig = {
    enabled: false,
    scopes: [],
    stderr: false,
    file: true,
    filePath: null,
    minDurationMs: 0,
    summaryOnExit: false,
    detail: "phases",
};

export function getGenesisToolsStorage(): Storage {
    return storage;
}

export function getGenesisToolsConfigPath(): string {
    return storage.getConfigPath();
}

export interface GenesisToolsConfig {
    profiling?: Partial<ProfilingConfig>;
    browser?: string;
}

export function getProfilingConfig(): ProfilingConfig {
    return { ...DEFAULT_PROFILING, ...readProfilingFromDisk() };
}

function readProfilingFromDisk(): Partial<ProfilingConfig> {
    const path = storage.getConfigPath();

    if (!existsSync(path)) {
        return {};
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
        logger.debug({ err, path }, "GenesisTools config: failed to parse, using profiling defaults");
        return {};
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
    }

    const profiling = (parsed as Record<string, unknown>).profiling;

    if (!profiling || typeof profiling !== "object" || Array.isArray(profiling)) {
        return {};
    }

    return pickProfiling(profiling as Record<string, unknown>);
}

export async function setProfilingConfig(patch: Partial<ProfilingConfig>): Promise<ProfilingConfig> {
    const next: ProfilingConfig = { ...getProfilingConfig(), ...patch };
    await storage.setConfigValue("profiling", next);
    return next;
}

function pickProfiling(raw: Record<string, unknown>): Partial<ProfilingConfig> {
    const out: Partial<ProfilingConfig> = {};

    if (typeof raw.enabled === "boolean") {
        out.enabled = raw.enabled;
    }

    if (Array.isArray(raw.scopes) && raw.scopes.every((s) => typeof s === "string")) {
        out.scopes = raw.scopes;
    }

    if (typeof raw.stderr === "boolean") {
        out.stderr = raw.stderr;
    }

    if (typeof raw.file === "boolean") {
        out.file = raw.file;
    }

    if (raw.filePath === null || typeof raw.filePath === "string") {
        out.filePath = raw.filePath;
    }

    if (typeof raw.minDurationMs === "number" && Number.isFinite(raw.minDurationMs) && raw.minDurationMs >= 0) {
        out.minDurationMs = raw.minDurationMs;
    }

    if (typeof raw.summaryOnExit === "boolean") {
        out.summaryOnExit = raw.summaryOnExit;
    }

    if (raw.detail === "phases" || raw.detail === "all") {
        out.detail = raw.detail;
    }

    return out;
}
