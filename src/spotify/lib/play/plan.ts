/**
 * Playback plans: which tracks to sample, where in each track to listen, and how.
 *
 * Ported from the mcp-scripting `spotifyPreview` preset, which had exactly ONE preset file.
 * Plans here are named and kept side by side as `<date>-<name>.json` under
 * `~/.genesis-tools/spotify/play/`, because "the gems I never played" and "everything I
 * loved in 2019" are different listening sessions and each wants its own progress.
 *
 * There is no "active plan" pointer: a plan is just a file. `play run` uses the newest unless
 * `--plan <name>` says otherwise, which keeps the single-plan workflow reading as
 * "set it once, then `play run --resume`" with no extra state to get out of sync.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { playDir } from "@app/spotify/lib/paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const log = logger.child({ component: "spotify:play" });

/** One sample window: seek to `start` seconds, listen for `duration` seconds. */
export type PlayWindow = [start: number, duration: number];

export interface PlayPlan {
    /** Sample windows applied to every track, in order. */
    windows: PlayWindow[];
    /** Load the whole run into the player queue so next/previous work (vs. standalone plays). */
    queue: boolean;
    /** Path to the tracks JSON: `[{uri, name?, artists?, windows?}]` or `{all: [...]}`. */
    tracks?: string;
    /** Pause between tracks, in milliseconds. */
    betweenMs: number;
    /** Free text shown in `play plan list`, e.g. "gems, 30 of them, 30s each". */
    note?: string;
}

export const DEFAULT_PLAN: PlayPlan = {
    windows: [
        [10, 3],
        [20, 3],
        [30, 3],
    ],
    queue: true,
    betweenMs: 600,
};

/** A plan on disk: the file that holds it, plus the name and date encoded in that filename. */
export interface NamedPlan {
    name: string;
    /** `YYYY-MM-DD`, taken from the filename so the list sorts by when it was made. */
    date: string;
    path: string;
    plan: PlayPlan;
}

const PLAN_SUFFIX = ".json";
const LEGACY_PLAN = "plan.json";

/** Filenames are user input via `plan new <name>`, and they go into a path. */
export function safePlanName(name: string): string {
    const safe = name
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!safe) {
        throw new Error(`"${name}" has no usable characters for a plan name. Use letters, digits, - or _.`);
    }

    return safe.toLowerCase();
}

function planFile(date: string, name: string): string {
    return join(playDir(), `${date}-${name}${PLAN_SUFFIX}`);
}

/** The seeded track list that `plan new` writes beside its plan. Not itself a plan. */
const TRACKS_SUFFIX = ".tracks.json";

/** `2026-08-17-gems.json` → `{ date, name }`. Anything else is not a plan file. */
function parsePlanFile(file: string): { date: string; name: string } | null {
    // `<date>-<name>.tracks.json` also matches the pattern below, and listing it as a plan
    // named "gems.tracks" (whose own tracks file is missing) is pure noise.
    if (file === LEGACY_PLAN || file.endsWith(TRACKS_SUFFIX)) {
        return null;
    }

    const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.json$/.exec(file);
    if (!m) {
        return null;
    }

    return { date: m[1]!, name: m[2]! };
}

function readPlanFile(path: string): PlayPlan {
    const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as Partial<PlayPlan>;

    return {
        windows: raw.windows?.length ? raw.windows : DEFAULT_PLAN.windows,
        queue: raw.queue ?? DEFAULT_PLAN.queue,
        tracks: raw.tracks,
        betweenMs: raw.betweenMs ?? DEFAULT_PLAN.betweenMs,
        note: raw.note,
    };
}

/**
 * The pre-naming `plan.json` becomes a normal named plan the first time plans are listed.
 * Renamed rather than copied, so it cannot be migrated twice into two rival plans.
 */
function migrateLegacyPlan(): void {
    const legacy = join(playDir(), LEGACY_PLAN);
    if (!existsSync(legacy)) {
        return;
    }

    const target = planFile(new Date().toISOString().slice(0, 10), "default");
    if (existsSync(target)) {
        return;
    }

    renameSync(legacy, target);
    log.info({ from: legacy, to: target }, "migrated the single playback plan to a named one");
}

export function listPlans(): NamedPlan[] {
    const dir = playDir();
    if (!existsSync(dir)) {
        return [];
    }

    migrateLegacyPlan();

    return readdirSync(dir)
        .map((file) => ({ file, parsed: parsePlanFile(file) }))
        .filter((e): e is { file: string; parsed: { date: string; name: string } } => e.parsed !== null)
        .map(({ file, parsed }) => ({
            name: parsed.name,
            date: parsed.date,
            path: join(dir, file),
            // mtime breaks same-day ties. The filename only carries a date, so two plans made
            // on one afternoon would otherwise be ordered alphabetically and `play run` would
            // pick "gems" over the "nostalgia" just created.
            mtimeMs: statSync(join(dir, file)).mtimeMs,
            plan: readPlanFile(join(dir, file)),
        }))
        .sort((a, b) => b.date.localeCompare(a.date) || b.mtimeMs - a.mtimeMs)
        .map(({ mtimeMs: _mtimeMs, ...p }) => p);
}

export function findPlan(name: string): NamedPlan | undefined {
    const want = safePlanName(name);

    return listPlans().find((p) => p.name === want);
}

/** The plan `play run` uses when no `--plan` is given: simply the newest. */
export function newestPlan(): NamedPlan | undefined {
    return listPlans()[0];
}

export function writePlan(name: string, plan: PlayPlan, date = new Date().toISOString().slice(0, 10)): NamedPlan {
    const safe = safePlanName(name);
    mkdirSync(playDir(), { recursive: true });
    const existing = findPlan(safe);
    const path = existing?.path ?? planFile(date, safe);
    atomicWriteFileSync(path, `${SafeJSON.stringify(plan, null, 2)}\n`);

    return { name: safe, date: existing?.date ?? date, path, plan };
}

export function planPath(): string {
    return newestPlan()?.path ?? join(playDir(), LEGACY_PLAN);
}

/** The chosen plan's settings (newest when unnamed), or the defaults when none exist. */
export function loadPlan(name?: string): PlayPlan {
    if (name) {
        const found = findPlan(name);
        if (!found) {
            throw new Error(`no plan named "${name}". List them: tools spotify play plan list`);
        }

        return found.plan;
    }

    return newestPlan()?.plan ?? { ...DEFAULT_PLAN };
}

/** Writes to the newest plan, creating a `default` one the first time. */
export function savePlan(plan: PlayPlan): string {
    const newest = newestPlan();

    return newest ? writePlan(newest.name, plan, newest.date).path : writePlan("default", plan).path;
}

/**
 * `"10:3,20:3,30:3"` → `[[10, 3], [20, 3], [30, 3]]`. Each chunk is `start:duration`
 * in seconds; a malformed chunk names itself in the error instead of sampling silence.
 */
export function parseWindows(spec: string): PlayWindow[] {
    const windows = spec
        .split(",")
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk): PlayWindow => {
            // Arity is checked, not just the two values destructured: `10:3:5` otherwise
            // parsed as [10, 3] and dropped the third part in silence, which is exactly the
            // "sampling something you did not ask for" this function exists to prevent.
            const parts = chunk.split(":");
            const [a, b] = parts.map((n) => Number(n.trim()));

            if (parts.length !== 2 || !Number.isFinite(a) || !Number.isFinite(b) || a! < 0 || b! <= 0) {
                throw new Error(`bad --windows chunk '${chunk}'. Use start:duration in seconds, e.g. 10:3,20:3`);
            }

            return [a!, b!];
        });

    if (!windows.length) {
        throw new Error("--windows named no windows. Use start:duration pairs, e.g. 10:3,20:3");
    }

    return windows;
}

export function formatWindows(windows: PlayWindow[]): string {
    return windows.map(([start, duration]) => `${start}:${duration}`).join(",");
}

export interface PlayTrack {
    uri: string;
    name?: string;
    artists?: string;
    /** Per-track override of the plan's windows — "play THIS one for 30s from 0:40". */
    windows?: PlayWindow[];
}

/** Accepts a bare array or `{all: [...]}` — both shapes the harvest exports produce. */
export function loadTracks(path: string): PlayTrack[] {
    if (!existsSync(path)) {
        throw new Error(`tracks file not found: ${path}`);
    }

    const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as PlayTrack[] | { all?: PlayTrack[] };
    const tracks = Array.isArray(raw) ? raw : raw.all;

    if (!Array.isArray(tracks)) {
        throw new Error(`${path} is neither an array of tracks nor {all: [...]}`);
    }

    const missing = tracks.findIndex((t) => typeof t?.uri !== "string" || !t.uri.startsWith("spotify:"));
    if (missing >= 0) {
        throw new Error(`${path}: entry ${missing} has no spotify: uri`);
    }

    return tracks;
}
