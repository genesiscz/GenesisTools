/**
 * Profile management. Everything else reads through these.
 *
 * The dashboard needs the same three verbs the CLI has (list, add, remove) so the data
 * directories can be pointed somewhere else without dropping to a terminal.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadAllPlays } from "@app/spotify/lib/history";
import { loadLibrary } from "@app/spotify/lib/library";
import { expandHome } from "@app/spotify/lib/paths";
import {
    DEFAULT_TIMEZONE,
    getProfile,
    loadRegistry,
    type Profile,
    removeProfile,
    resolveHistoryDir,
    setDefaultProfile,
    upsertProfile,
} from "@app/spotify/lib/profiles";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:profiles-report" });

export interface ProfileRow extends Profile {
    isDefault: boolean;
    historyExists: boolean;
    dataExists: boolean;
}

export interface ProfileListReport {
    defaultProfile: string;
    registryPath: string;
    profiles: ProfileRow[];
}

export function profileList(registryPathValue: string): ProfileListReport {
    const reg = loadRegistry();

    return {
        defaultProfile: reg.defaultProfile,
        registryPath: registryPathValue,
        profiles: reg.profiles.map((p) => ({
            ...p,
            isDefault: p.name === reg.defaultProfile,
            historyExists: !!p.historyDir && existsSync(p.historyDir),
            dataExists: !!p.dataDir && existsSync(p.dataDir),
        })),
    };
}

export interface ProfileDetail {
    profile: Profile;
    events: number;
    span: { from: string; to: string } | null;
    likedTracks: number;
}

export function profileDetail(name?: string): ProfileDetail {
    const p = getProfile(name);
    const plays = p.historyDir ? loadAllPlays(p) : [];
    const lib = loadLibrary(p);

    return {
        profile: p,
        events: plays.length,
        span: plays.length
            ? {
                  from: new Date(plays[0]!.ts).toISOString(),
                  to: new Date(plays[plays.length - 1]!.ts).toISOString(),
              }
            : null,
        likedTracks: lib.length,
    };
}

export interface ProfileAddInput {
    name: string;
    history?: string;
    data?: string;
    label?: string;
    tz?: string;
}

/**
 * A profile name that is safe to put in a filename. The history cache is written to
 * `<cache>/<name>-<signature>.json`, so a name carrying a path separator or a `..` would read
 * and write outside the cache directory. Checked here because both doors land on `profileAdd`.
 */
function requireProfileName(raw: string | undefined): string {
    const name = raw?.trim();
    if (!name) {
        throw new Error("a profile needs a name");
    }

    if (/[/\\]/.test(name) || name === "." || name === ".." || name.includes("..")) {
        throw new Error(`invalid profile name "${name}": no path separators or ".."`);
    }

    return name;
}

/**
 * A timezone the runtime actually knows. Anything else is persisted happily and then throws
 * from `toLocaleString` on every later report, far from the command that stored it.
 */
function requireTimezone(tz: string): string {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch (err) {
        log.debug({ tz, err }, "rejected an unknown timezone");

        throw new Error(`unknown timezone "${tz}". Use an IANA name such as ${DEFAULT_TIMEZONE}.`);
    }

    return tz;
}

/**
 * Register (or repoint) a profile. Existing fields survive an update that omits them, so
 * `profile add me --data <dir>` keeps the history directory it already had.
 *
 * The validation lives here rather than in the callers: the CLI and the dashboard's write
 * route both land on this function, and only one of them was checking anything.
 */
export function profileAdd(input: ProfileAddInput): ProfileDetail {
    const name = requireProfileName(input.name);

    if (input.tz !== undefined) {
        requireTimezone(input.tz);
    }

    const existing = loadRegistry().profiles.find((p) => p.name === name);
    const historyDir = input.history ? resolveHistoryDir(input.history) : existing?.historyDir;
    const dataDir = input.data ? resolve(expandHome(input.data)) : existing?.dataDir;
    if (dataDir && !existsSync(dataDir)) {
        throw new Error(`no such directory: ${dataDir}`);
    }

    const saved = upsertProfile({
        name,
        label: input.label ?? existing?.label ?? name,
        historyDir,
        dataDir,
        timezone: input.tz ?? existing?.timezone ?? DEFAULT_TIMEZONE,
    });

    return profileDetail(saved.name);
}

export function profileRemove(name: string): void {
    if (!removeProfile(name)) {
        throw new Error(`no profile "${name}"`);
    }
}

export function profileUse(name: string): void {
    setDefaultProfile(name);
}
