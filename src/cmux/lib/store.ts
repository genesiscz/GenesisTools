import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PROFILE_VERSION, type Profile, type ProfileSummary } from "@app/cmux/lib/types";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export class ProfileStore {
    private profilesDir: string;

    constructor(opts: { profilesDir?: string } = {}) {
        if (opts.profilesDir) {
            this.profilesDir = opts.profilesDir;
        } else {
            const storage = new Storage("cmux");
            this.profilesDir = join(storage.getBaseDir(), "profiles");
        }
    }

    getProfilesDir(): string {
        return this.profilesDir;
    }

    pathFor(name: string): string {
        if (!NAME_PATTERN.test(name)) {
            throw new Error(
                `Invalid profile name "${name}". Use letters, digits, dots, underscores, or dashes (no slashes).`
            );
        }
        return join(this.profilesDir, `${name}.json`);
    }

    private ensureDir(): void {
        if (!existsSync(this.profilesDir)) {
            mkdirSync(this.profilesDir, { recursive: true });
        }
    }

    exists(name: string): boolean {
        return existsSync(this.pathFor(name));
    }

    list(): ProfileSummary[] {
        if (!existsSync(this.profilesDir)) {
            return [];
        }
        const entries = readdirSync(this.profilesDir).filter((f) => f.endsWith(".json"));
        const summaries: ProfileSummary[] = [];
        for (const entry of entries) {
            const filePath = join(this.profilesDir, entry);
            try {
                const profile = readJson<Profile>(filePath);
                summaries.push(summarize(profile, filePath));
            } catch (error) {
                logger.warn({ filePath, error }, "[store] skipping unreadable profile");
            }
        }
        summaries.sort((a, b) => a.name.localeCompare(b.name));
        return summaries;
    }

    read(name: string): Profile {
        const path = this.pathFor(name);
        if (!existsSync(path)) {
            throw new ProfileNotFoundError(name, path);
        }
        const profile = readJson<Profile>(path);
        if (profile.version !== PROFILE_VERSION) {
            throw new Error(
                `Profile "${name}" has version ${profile.version}; this CLI only supports version ${PROFILE_VERSION}.`
            );
        }
        return profile;
    }

    write(name: string, profile: Profile, opts: { force?: boolean } = {}): string {
        const path = this.pathFor(name);
        if (existsSync(path) && !opts.force) {
            throw new ProfileExistsError(name, path);
        }
        this.ensureDir();
        const normalized: Profile = { ...profile, name, version: PROFILE_VERSION };
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

    summarize(profile: Profile): ProfileSummary {
        return summarize(profile, this.pathFor(profile.name));
    }
}

export class ProfileNotFoundError extends Error {
    constructor(
        public readonly name: string,
        public readonly path: string
    ) {
        super(`No profile named "${name}" at ${path}`);
        this.name = "ProfileNotFoundError";
    }
}

export class ProfileExistsError extends Error {
    constructor(
        public readonly profileName: string,
        public readonly path: string
    ) {
        super(`Profile "${profileName}" already exists at ${path}. Use --force to overwrite.`);
        this.name = "ProfileExistsError";
    }
}

function readJson<T>(path: string): T {
    const raw = readFileSync(path, "utf8");
    return SafeJSON.parse(raw) as T;
}

function summarize(profile: Profile, path: string): ProfileSummary {
    let workspaces = 0;
    let panes = 0;
    let surfaces = 0;
    for (const window of profile.windows) {
        workspaces += window.workspaces.length;
        for (const ws of window.workspaces) {
            panes += ws.panes.length;
            for (const pane of ws.panes) {
                surfaces += pane.surfaces.length;
            }
        }
    }
    let bytes = 0;
    try {
        bytes = statSync(path).size;
    } catch {
        // file may not exist yet; bytes stays 0
    }
    return {
        name: profile.name,
        captured_at: profile.captured_at,
        scope: profile.scope,
        note: profile.note,
        cmux_version: profile.cmux_version,
        windows: profile.windows.length,
        workspaces,
        panes,
        surfaces,
        bytes,
        path,
    };
}
