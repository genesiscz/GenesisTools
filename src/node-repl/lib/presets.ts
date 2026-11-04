import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

const { log } = logger.scoped("node-repl-presets");

/**
 * A saved REPL script an agent runs again with other values (a demo that worked, a cleanup it repeats). Kept the way
 * `tools scripts` keeps scripts: one folder per preset, the code in its own file you may edit (`script.js`), its
 * metadata beside it (`preset.json`), and a removed preset moved to `.trash/` rather than deleted.
 */
export const PRESET_VERSION = 1;
export const PRESET_SCRIPT = "script.js";
export const PRESET_META = "preset.json";

export const PARAM_TYPES = ["string", "number", "boolean", "json"] as const;

export const presetParamSchema = z
    .object({
        type: z.enum(PARAM_TYPES).default("string"),
        description: z.string().max(300).optional(),
        /** Absent makes the value required at every run. */
        default: z.unknown().optional(),
    })
    .strict();
export type PresetParam = z.infer<typeof presetParamSchema>;

const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const presetNameSchema = z
    .string()
    .regex(
        PRESET_NAME,
        "a preset name is 1–64 letters, digits, dots, dashes or underscores, starting with a letter or digit"
    );

export const presetMetaSchema = z
    .object({
        version: z.literal(PRESET_VERSION),
        name: presetNameSchema,
        description: z.string().max(500).optional(),
        /** The REPL toolsets the script uses (`movies`, `computer`, …); a run loads them. */
        toolsets: z.array(z.string()).default([]),
        params: z.record(z.string(), presetParamSchema).default({}),
        createdAt: z.string(),
        updatedAt: z.string(),
        runs: z.number().int().nonnegative().default(0),
        lastRunAt: z.string().optional(),
    })
    .strict();
export type PresetMeta = z.infer<typeof presetMetaSchema>;

export interface Preset {
    meta: PresetMeta;
    script: string;
    folder: string;
}

/** `~/.genesis-tools/node-repl/presets` (GENESIS_TOOLS_HOME in tests). */
export function presetsRoot(): string {
    return genesisToolsDir("node-repl", "presets");
}

export const savePresetSchema = z
    .object({
        script: z.string().trim().min(1, "a preset needs its script"),
        description: z.string().max(500).optional(),
        toolsets: z.array(z.string()).optional(),
        params: z.record(z.string(), presetParamSchema).optional(),
    })
    .strict();

/** The toolsets a script names as `<id>.` (movies.demo, computer.click), for a save that names none. */
export function toolsetsNamedIn(script: string, ids: readonly string[]): string[] {
    return ids.filter((id) => new RegExp(`(^|[^\\w.$])${id}\\.`).test(script));
}

/** Saves (or replaces) a preset; a replace keeps its created time and run count. */
export function savePreset(options: {
    name: string;
    input: z.input<typeof savePresetSchema>;
    knownToolsets: readonly string[];
    root?: string;
    now?: Date;
}): Preset {
    const name = presetNameSchema.parse(options.name);
    const input = savePresetSchema.parse(options.input);
    const root = options.root ?? presetsRoot();
    const folder = join(root, name);
    const now = (options.now ?? new Date()).toISOString();
    const previous = existsSync(join(folder, PRESET_META)) ? readPreset(name, root).meta : undefined;
    const unknown = (input.toolsets ?? []).filter((id) => !options.knownToolsets.includes(id));

    if (unknown.length > 0) {
        throw new Error(`unknown toolset ${unknown.join(", ")}; known: ${options.knownToolsets.join(", ")}`);
    }

    const meta = presetMetaSchema.parse({
        version: PRESET_VERSION,
        name,
        ...(input.description ? { description: input.description } : {}),
        toolsets: input.toolsets ?? toolsetsNamedIn(input.script, options.knownToolsets),
        params: input.params ?? {},
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        runs: previous?.runs ?? 0,
        ...(previous?.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}),
    });
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, PRESET_SCRIPT), `${input.script.trimEnd()}\n`);
    writeFileSync(join(folder, PRESET_META), `${SafeJSON.stringify(meta, null, 2)}\n`);
    log.info({ name, folder, toolsets: meta.toolsets, params: Object.keys(meta.params) }, "preset saved");
    return { meta, script: input.script, folder };
}

export function readPreset(name: string, root = presetsRoot()): Preset {
    const folder = join(root, presetNameSchema.parse(name));
    const metaPath = join(folder, PRESET_META);

    if (!existsSync(metaPath)) {
        const known = listPresets(root).map((preset) => preset.name);
        throw new Error(`no preset "${name}"; saved: ${known.join(", ") || "none"}`);
    }

    const meta = presetMetaSchema.parse(SafeJSON.parse(readFileSync(metaPath, "utf8"), { strict: true }));
    return { meta, script: readFileSync(join(folder, PRESET_SCRIPT), "utf8"), folder };
}

/** Every preset's metadata, by name; a folder whose metadata does not parse is logged and left out. */
export function listPresets(root = presetsRoot()): PresetMeta[] {
    if (!existsSync(root)) {
        return [];
    }

    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .flatMap((entry) => {
            const path = join(root, entry.name, PRESET_META);

            if (!existsSync(path)) {
                return [];
            }

            const parsed = presetMetaSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));

            if (!parsed.success) {
                log.warn({ path, issues: parsed.error.issues.length }, "preset.json does not parse; left out");
                return [];
            }

            return [parsed.data];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Moves the preset to `.trash/<name>-<time>`; returns where, so it can be moved back. */
export function removePreset(name: string, root = presetsRoot(), now = new Date()): string {
    const { folder } = readPreset(name, root);
    const trash = join(root, ".trash");
    mkdirSync(trash, { recursive: true });
    const target = join(trash, `${name}-${now.toISOString().replace(/[:.]/g, "-")}`);
    renameSync(folder, target);
    log.info({ name, target }, "preset moved to the trash");
    return target;
}

/** A value given as text (a CLI `--param k=v`) read as the param's type. */
export function coerceParam(name: string, param: PresetParam, raw: string): unknown {
    switch (param.type) {
        case "string":
            return raw;
        case "number": {
            const value = Number(raw);

            if (raw.trim() === "" || !Number.isFinite(value)) {
                throw new Error(`param ${name} takes a number (got "${raw}")`);
            }

            return value;
        }
        case "boolean":
            if (["true", "1", "yes", "on"].includes(raw.toLowerCase())) {
                return true;
            }

            if (["false", "0", "no", "off"].includes(raw.toLowerCase())) {
                return false;
            }

            throw new Error(`param ${name} takes true or false (got "${raw}")`);
        case "json":
            return SafeJSON.parse(raw, { strict: true });
    }
}

/** The values a run gets: the defaults, then `values`. Refuses an unknown name and a missing required one. */
export function resolveParams(meta: PresetMeta, values: Record<string, unknown> = {}): Record<string, unknown> {
    const declared = Object.keys(meta.params);
    const unknown = Object.keys(values).filter((key) => !declared.includes(key));

    if (unknown.length > 0) {
        throw new Error(
            `preset ${meta.name} has no param ${unknown.join(", ")}; its params: ${declared.join(", ") || "none"}`
        );
    }

    const resolved: Record<string, unknown> = {};

    for (const [key, param] of Object.entries(meta.params)) {
        const value = Object.hasOwn(values, key) ? values[key] : param.default;

        if (value === undefined) {
            throw new Error(`preset ${meta.name} needs ${key}${param.description ? ` (${param.description})` : ""}`);
        }

        resolved[key] = value;
    }

    return resolved;
}

/** Counts a run in the preset's metadata (best effort: a failed write is logged, never fails the run). */
export function noteRun(name: string, root = presetsRoot(), now = new Date()): void {
    try {
        const { meta, folder } = readPreset(name, root);
        const next = { ...meta, runs: meta.runs + 1, lastRunAt: now.toISOString() };
        writeFileSync(join(folder, PRESET_META), `${SafeJSON.stringify(next, null, 2)}\n`);
    } catch (error) {
        log.debug({ name, error }, "the preset's run count was not written");
    }
}
