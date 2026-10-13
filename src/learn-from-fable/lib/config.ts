import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

export const FABLE_LOCAL_DIR = resolve(env.tools.getHome(), ".genesis-tools", "claude", "fable");
export const FABLE_CONFIG_PATH = join(FABLE_LOCAL_DIR, "config.json");
export const FABLE_MODEL = "claude-fable-5-1";

/**
 * Model calls in flight per stage. Every stage's units of work (windows,
 * episodes, judge batches) are independent, and the proxy fans them out cleanly:
 * 20 concurrent grok-4.5 calls finished in 8.9s wall against a 133s serial sum
 * (probe, 2026-07-24). Bounded only to keep upstream rate limits happy.
 */
export const STAGE_CONCURRENCY = 6;

export interface FableStageModels {
    /** Extractor for the mine stage (decision points + principles). */
    mine?: string;
    /** Bare model the contrastive filter measures headroom against. */
    filterBare?: string;
    /** Judge model (contrastive filter + A/B eval grading). */
    judge?: string;
    /** Target model for the A/B eval (bare vs +skill). */
    eval?: string;
}

export interface FableConfig {
    /** Git-versioned pack repo (spec, traces, skills, manifests). Lives outside this repo. */
    packPath: string;
    /** Legacy read-only raw transcript mirror (machine-local). */
    sessionsMirrorPath: string;
    /** Directories miners enumerate for transcripts; deduped by session stem keeping the largest file. */
    sessionSources: string[];
    /** Default ai-proxy model ids per stage (full <account>/<provider>/<model> ids; CLI flags override). */
    models?: FableStageModels;
    notes?: string;
}

/**
 * Stage model ids come from config.json (machine-specific, account-qualified —
 * never hardcoded in code) or per-command --model flags. Missing = the stage
 * refuses to run and tells the user which config key / flag to set.
 */
export function requireStageModel(config: FableConfig, stage: keyof FableStageModels, flagValue?: string): string {
    const model = flagValue ?? config.models?.[stage];
    if (!model) {
        throw new Error(
            `No model configured for stage '${stage}'. Set models.${stage} in ${FABLE_CONFIG_PATH} ` +
                `(full <account>/<provider>/<model> id) or pass --model.`
        );
    }

    return model;
}

export interface PackPaths {
    pack: string;
    spec: string;
    goldenTraces: string;
    changelog: string;
    processedManifest: string;
    skilloptManifest: string;
    minedManifest: string;
    metaDir: string;
    stageRunsPath: string;
    episodesDir: string;
    principlesDir: string;
    skillDir: string;
}

export function packPaths(config: FableConfig): PackPaths {
    const pack = config.packPath;
    return {
        pack,
        spec: join(pack, "pack", "FABLE-SPEC.md"),
        goldenTraces: join(pack, "pack", "golden-traces.md"),
        changelog: join(pack, "pack", "changelog.md"),
        processedManifest: join(pack, "processed.jsonl"),
        skilloptManifest: join(pack, "skillopt-data", "mined.jsonl"),
        minedManifest: join(pack, "meta", "mined.jsonl"),
        metaDir: join(pack, "meta"),
        stageRunsPath: join(pack, "meta", "stage-runs.jsonl"),
        episodesDir: join(pack, "meta", "episodes"),
        principlesDir: join(pack, "meta", "principles"),
        skillDir: join(pack, "skills", "fable-style"),
    };
}

function defaultSessionSources(): string[] {
    return [resolve(homedir(), ".claude", "projects"), join(FABLE_LOCAL_DIR, "sessions")];
}

function isFableConfigDocument(value: unknown): value is Partial<FableConfig> {
    return isJsonObject(value);
}

/**
 * The saved document, `undefined` when there is no file. Throws, naming the path, when the file exists
 * but is not a JSON object: bootstrap would otherwise write a fresh config over it and drop `models`.
 */
function readFableConfigDocument(path: string): Partial<FableConfig> | undefined {
    let text: string;

    try {
        text = readFileSync(path, "utf-8");
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return undefined;
        }

        throw err;
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(text);
    } catch (err) {
        throw new Error(`Fable config ${path} does not parse, so it was left untouched. Fix it, then retry.`, {
            cause: err,
        });
    }

    if (!isFableConfigDocument(parsed)) {
        throw new Error(`Fable config ${path} is not a JSON object, so it was left untouched. Fix it, then retry.`);
    }

    return parsed;
}

export function loadFableConfig(path = FABLE_CONFIG_PATH): FableConfig | undefined {
    const raw = readFableConfigDocument(path);

    if (!raw) {
        return undefined;
    }

    if (!raw.packPath) {
        logger.warn({ path }, "fable config missing packPath");
        return undefined;
    }

    return {
        packPath: raw.packPath,
        sessionsMirrorPath: raw.sessionsMirrorPath ?? join(FABLE_LOCAL_DIR, "sessions"),
        sessionSources: raw.sessionSources?.length ? raw.sessionSources : defaultSessionSources(),
        models: raw.models,
        notes: raw.notes,
    };
}

/**
 * Point the config at `packPath` and save it, keeping every other saved field (`models`, `notes`,
 * `sessionSources`). Throws, leaving the file untouched, when the existing file does not parse.
 */
export function bootstrapFableConfig({
    packPath,
    notes,
    path = FABLE_CONFIG_PATH,
}: {
    packPath: string;
    /** Used only when the saved config has no notes of its own. */
    notes: string;
    path?: string;
}): FableConfig {
    const existing = readFableConfigDocument(path) ?? {};
    const config: FableConfig = {
        ...existing,
        packPath,
        sessionsMirrorPath: existing.sessionsMirrorPath ?? join(FABLE_LOCAL_DIR, "sessions"),
        sessionSources: existing.sessionSources?.length ? existing.sessionSources : defaultSessionSources(),
        notes: existing.notes ?? notes,
    };
    saveFableConfig(config, path);
    return config;
}

export function saveFableConfig(config: FableConfig, path = FABLE_CONFIG_PATH): void {
    atomicWriteFileSync(path, `${SafeJSON.stringify(config, null, 2)}\n`);
    logger.info({ path, packPath: config.packPath }, "fable config saved");
}

/** Ensure the meta dirs used by stage runs exist (idempotent). */
export function ensureMetaDirs(config: FableConfig): PackPaths {
    const paths = packPaths(config);
    mkdirSync(paths.metaDir, { recursive: true });
    mkdirSync(paths.episodesDir, { recursive: true });
    mkdirSync(paths.principlesDir, { recursive: true });
    return paths;
}
