/**
 * Profiles let the same reports run against more than one person's data, which is what
 * makes the compatibility reports possible at all. A profile is just two directories:
 * the unzipped Extended Streaming History, and the harvested library (optional — a partner
 * who never ran the browser harvest still gets every history-based statistic).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bootstrapRoots, expandHome, legacyRegistryPath, registryPath } from "@app/spotify/lib/paths";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const log = logger.child({ component: "spotify:profiles" });

export const DEFAULT_TIMEZONE = "Europe/Prague";

export interface Profile {
    name: string;
    label: string;
    historyDir?: string;
    dataDir?: string;
    timezone: string;
    addedAt: string;
}

export interface Registry {
    defaultProfile: string;
    profiles: Profile[];
}

const EMPTY: Registry = { defaultProfile: "me", profiles: [] };

function isRegistry(value: unknown): value is Registry {
    return isJsonObject(value) && Array.isArray(value.profiles);
}

/**
 * The registry at `path`, or null when there is no file. A file that exists but cannot be read, does not parse
 * or has no profiles array throws: bootstrapping over it would make the next save replace the user's profiles.
 */
function readRegistryFile(path: string): Registry | null {
    if (!existsSync(path)) {
        return null;
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(
            `profile registry at ${path} cannot be read or does not parse; left untouched, fix or move it`,
            {
                cause: error,
            }
        );
    }

    if (!isRegistry(parsed)) {
        throw new Error(`profile registry at ${path} has no profiles array; left untouched, fix or move it`);
    }

    return parsed;
}

/** The standalone skill's registry is only a first-run import, so an unreadable one is skipped, not fatal. */
function readLegacyRegistry(): Registry | null {
    try {
        return readRegistryFile(legacyRegistryPath());
    } catch (err) {
        log.warn({ path: legacyRegistryPath(), err }, "legacy me:spotify registry is unreadable, not importing it");

        return null;
    }
}

/**
 * First run: inherit the standalone skill's registry if it exists, otherwise look for the
 * export in the two places it is normally unzipped to.
 */
function bootstrap(): Registry {
    const legacy = readLegacyRegistry();
    if (legacy?.profiles?.length) {
        log.info(
            { path: legacyRegistryPath(), profiles: legacy.profiles.length },
            "imported legacy me:spotify profiles"
        );

        return legacy;
    }

    for (const root of bootstrapRoots()) {
        const data = join(root, "data");
        const history = join(root, "streaming-history");
        if (!existsSync(data) && !existsSync(history)) {
            continue;
        }

        log.info({ root }, "bootstrapped a `me` profile from a well-known export directory");

        return {
            defaultProfile: "me",
            profiles: [
                {
                    name: "me",
                    label: "me",
                    historyDir: existsSync(history) ? history : undefined,
                    dataDir: existsSync(data) ? data : undefined,
                    timezone: DEFAULT_TIMEZONE,
                    addedAt: new Date().toISOString(),
                },
            ],
        };
    }

    return EMPTY;
}

/**
 * The registry, bootstrapping a first run in memory and writing NOTHING.
 *
 * Reading never persists, for anyone. The first version of this saved the bootstrap, which
 * meant `doctor` created the file it was inspecting; the fix at the time exempted `doctor` and
 * `profile list`, and `profile show` was promptly found still doing it. Fixing the callers one
 * at a time is what this repo's own rule warns against — "a new safety parameter leaves every
 * existing caller unsafe" — so the read path simply cannot write.
 *
 * The bootstrap is cheap to redo (two `existsSync` calls) and is persisted the moment the user
 * does something that writes: `profile add`, `profile rm`, `profile use`. It runs only when the
 * file is missing; an existing file that does not parse throws, so no save can replace it.
 */
export function loadRegistry(): Registry {
    return readRegistryFile(registryPath()) ?? bootstrap();
}

export function saveRegistry(reg: Registry): void {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(reg, null, 2)}\n`);
    log.debug({ path, profiles: reg.profiles.length }, "saved profile registry");
}

export function getProfile(name?: string): Profile {
    const reg = loadRegistry();
    const want = name ?? env.spotify.getProfile() ?? reg.defaultProfile;
    const found = reg.profiles.find((p) => p.name === want);
    if (!found) {
        const known = reg.profiles.map((p) => p.name).join(", ") || "(none)";

        throw new Error(
            `no profile "${want}". Known: ${known}. Add one with:\n` +
                `  ${toolCommand("spotify profile add", want, "--history", "<dir>")} [--data <dir>]`
        );
    }

    return found;
}

export function upsertProfile(p: Omit<Profile, "addedAt"> & { addedAt?: string }): Profile {
    const reg = loadRegistry();
    const existing = reg.profiles.find((x) => x.name === p.name);
    const merged: Profile = {
        ...existing,
        ...p,
        addedAt: existing?.addedAt ?? p.addedAt ?? new Date().toISOString(),
    };

    reg.profiles = [...reg.profiles.filter((x) => x.name !== p.name), merged].sort((a, b) =>
        a.name.localeCompare(b.name)
    );
    if (!reg.profiles.some((x) => x.name === reg.defaultProfile)) {
        reg.defaultProfile = merged.name;
    }

    saveRegistry(reg);

    return merged;
}

export function removeProfile(name: string): boolean {
    const reg = loadRegistry();
    const before = reg.profiles.length;
    reg.profiles = reg.profiles.filter((p) => p.name !== name);
    if (reg.profiles.length === before) {
        return false;
    }

    if (reg.defaultProfile === name) {
        reg.defaultProfile = reg.profiles[0]?.name ?? "me";
    }

    saveRegistry(reg);

    return true;
}

export function setDefaultProfile(name: string): void {
    const reg = loadRegistry();
    if (!reg.profiles.some((p) => p.name === name)) {
        throw new Error(`no profile "${name}"`);
    }

    reg.defaultProfile = name;
    saveRegistry(reg);
}

/**
 * A person can hand over the export as the zip's inner folder, the folder above it, or the
 * folder holding the JSON files directly. Accept all three rather than making them guess.
 */
export function resolveHistoryDir(input: string): string {
    const abs = resolve(expandHome(input));
    if (!existsSync(abs)) {
        throw new Error(`no such directory: ${abs}`);
    }

    // Must be a DIRECTORY, not merely present. The loop below feeds every entry of `abs`
    // through this, and Spotify's export ships `ReadMeFirst_ExtendedStreamingHistory.pdf`
    // beside the data — `readdirSync` on that file threw a raw ENOTDIR at the user instead
    // of the explanatory error at the end of this function.
    const hasAudio = (d: string) =>
        (statSync(d, { throwIfNoEntry: false })?.isDirectory() ?? false) &&
        readdirSync(d).some((f) => f.startsWith("Streaming_History_Audio_") && f.endsWith(".json"));

    if (hasAudio(abs)) {
        return abs;
    }

    for (const child of readdirSync(abs)) {
        const candidate = join(abs, child);
        if (hasAudio(candidate)) {
            return candidate;
        }
    }

    throw new Error(`no Streaming_History_Audio_*.json under ${abs} or its immediate children`);
}

export function describeProfile(p: Profile): string {
    return [
        `${p.name}${p.label && p.label !== p.name ? ` (${p.label})` : ""}`,
        p.historyDir ? `history: ${p.historyDir}` : "history: —",
        p.dataDir ? `library: ${p.dataDir}` : "library: —",
        `tz: ${p.timezone}`,
    ].join("\n  ");
}
