import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";
import { SNAPSHOT_VERSION, type TmuxPreset } from "@app/utils/tmux/snapshot";

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface TmuxPresetSummary {
    name: string;
    capturedAt: string;
    sessions: number;
    windows: number;
    panes: number;
    bytes: number;
    note: string | undefined;
    path: string;
}

export class TmuxPresetStore {
    private dir: string;

    constructor(opts: { dir?: string } = {}) {
        if (opts.dir) {
            this.dir = opts.dir;
        } else {
            const storage = new Storage("cmux");
            this.dir = join(storage.getBaseDir(), "tmux-presets");
        }
    }

    getDir(): string {
        return this.dir;
    }

    pathFor(name: string): string {
        if (!NAME_PATTERN.test(name)) {
            throw new Error(
                `Invalid preset name "${name}". Use letters, digits, dots, underscores, or dashes (no slashes).`
            );
        }
        return join(this.dir, `${name}.json`);
    }

    exists(name: string): boolean {
        return existsSync(this.pathFor(name));
    }

    list(): TmuxPresetSummary[] {
        if (!existsSync(this.dir)) {
            return [];
        }

        const entries = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
        const summaries: TmuxPresetSummary[] = [];

        for (const entry of entries) {
            const filePath = join(this.dir, entry);
            try {
                const preset = readJson<TmuxPreset>(filePath);
                summaries.push(summarize(preset, filePath));
            } catch (error) {
                logger.warn({ filePath, error }, "[tmux-preset] skipping unreadable preset");
            }
        }

        summaries.sort((a, b) => a.name.localeCompare(b.name));
        return summaries;
    }

    read(name: string): TmuxPreset {
        const path = this.pathFor(name);

        if (!existsSync(path)) {
            throw new PresetNotFoundError(name, path);
        }

        const preset = readJson<TmuxPreset>(path);

        if (preset.version !== SNAPSHOT_VERSION) {
            throw new Error(
                `Preset "${name}" has version ${preset.version}; this CLI only supports version ${SNAPSHOT_VERSION}.`
            );
        }

        return preset;
    }

    write(name: string, preset: TmuxPreset, opts: { force?: boolean } = {}): string {
        const path = this.pathFor(name);

        if (existsSync(path) && !opts.force) {
            throw new PresetExistsError(name, path);
        }

        this.ensureDir();
        const normalized: TmuxPreset = { ...preset, name, version: SNAPSHOT_VERSION };
        const tmpPath = `${path}.tmp.${process.pid}`;
        writeFileSync(tmpPath, `${SafeJSON.stringify(normalized, null, 2)}\n`, "utf8");
        renameSync(tmpPath, path);
        return path;
    }

    delete(name: string): boolean {
        const path = this.pathFor(name);

        if (!existsSync(path)) {
            return false;
        }

        unlinkSync(path);
        return true;
    }

    summarize(preset: TmuxPreset): TmuxPresetSummary {
        return summarize(preset, this.pathFor(preset.name));
    }

    private ensureDir(): void {
        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true });
        }
    }
}

export class PresetNotFoundError extends Error {
    constructor(
        public readonly presetName: string,
        public readonly path: string
    ) {
        super(`No tmux preset named "${presetName}" at ${path}`);
        this.name = "PresetNotFoundError";
    }
}

export class PresetExistsError extends Error {
    constructor(
        public readonly presetName: string,
        public readonly path: string
    ) {
        super(`Tmux preset "${presetName}" already exists at ${path}. Use --force to overwrite.`);
        this.name = "PresetExistsError";
    }
}

function readJson<T>(path: string): T {
    const raw = readFileSync(path, "utf8");
    return SafeJSON.parse(raw) as T;
}

function summarize(preset: TmuxPreset, path: string): TmuxPresetSummary {
    let windows = 0;
    let panes = 0;

    for (const session of preset.sessions) {
        windows += session.windows.length;
        for (const window of session.windows) {
            panes += window.panes.length;
        }
    }

    let bytes = 0;
    try {
        bytes = statSync(path).size;
    } catch {
        // file may not exist yet; bytes stays 0
    }

    return {
        name: preset.name,
        capturedAt: preset.capturedAt,
        sessions: preset.sessions.length,
        windows,
        panes,
        bytes,
        note: preset.note,
        path,
    };
}
