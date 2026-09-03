import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { clonesProfile, measureItem } from "./profile";

const log = logger.child({ component: "clones:keep-partners" });

export const KEEP_PARTNER_IDS = ["bun", "npm", "pnpm", "yarn", "composer"] as const;

export type KeepPartnerId = (typeof KEEP_PARTNER_IDS)[number];

export interface PackageIdentity {
    dir: string;
    name: string;
    version: string;
}

export interface ResolvedKeepPartner {
    id: KeepPartnerId;
    root: string;
}

export type RunCommand = (argv: string[]) => string | null;

/** Each manager prints its own store root. Never build one from `$HOME`. */
const CACHE_COMMANDS: Record<KeepPartnerId, string[]> = {
    bun: ["bun", "pm", "cache"],
    npm: ["npm", "config", "get", "cache"],
    pnpm: ["pnpm", "store", "path"],
    yarn: ["yarn", "cache", "dir"],
    composer: ["composer", "config", "--global", "cache-dir"],
};

/** Run a cache-root command. Returns stdout, or null when the binary is
 *  missing or exits non-zero. stderr is logged, never discarded. */
export function spawnCacheCommand(argv: string[]): string | null {
    const res = measureItem("keep-partners.command", () =>
        spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 10_000 })
    );
    if (res.error || res.status !== 0) {
        log.debug({ argv, err: res.error, status: res.status, stderr: res.stderr?.trim() }, "cache command failed");
        return null;
    }

    return res.stdout;
}

function readIdentity(dir: string): PackageIdentity | null {
    let raw: string;
    try {
        raw = readFileSync(join(dir, "package.json"), "utf8");
    } catch (err) {
        log.debug({ err, dir }, "package.json read failed");
        return null;
    }

    const parsed = SafeJSON.parse(raw) as { name?: unknown; version?: unknown };
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
        return null;
    }

    return { dir, name: parsed.name, version: parsed.version };
}

/** Walk up from a file to the package directory that `node_modules` (or a
 *  `node_modules/@scope`) directly contains, then read its identity. */
export function packageIdentityOf(file: string): PackageIdentity | null {
    let dir = dirname(file);
    while (dir !== dirname(dir)) {
        const parent = dirname(dir);
        const parentName = basename(parent);
        const isPackageDir =
            parentName === "node_modules" ||
            (parentName.startsWith("@") && basename(dirname(parent)) === "node_modules");
        if (isPackageDir) {
            return readIdentity(dir);
        }

        dir = parent;
    }

    return null;
}

/** bun stores each install as `<bare-name>@<version>@@[<registry>]@@@<n>`,
 *  scoped packages under a `@scope/` directory, with the package tree intact
 *  inside. The `@` after the version is what keeps `plain` from matching
 *  `plainer`. Several entries can exist for one version (different
 *  registries), so every match is returned and the hash decides. */
export function bunCacheCandidates(
    cacheRoot: string,
    id: PackageIdentity,
    rel: string,
    listDir: (dir: string) => string[]
): string[] {
    const slash = id.name.indexOf("/");
    const parent = slash === -1 ? cacheRoot : join(cacheRoot, id.name.slice(0, slash));
    const bare = slash === -1 ? id.name : id.name.slice(slash + 1);
    const prefix = `${bare}@${id.version}@@`;
    return listDir(parent)
        .filter((entry) => entry.startsWith(prefix))
        .sort()
        .map((entry) => join(parent, entry, rel));
}

/** Ask each requested manager for its store root; keep the ones that answer
 *  with a directory that exists. */
export function resolveKeepPartners(ids: readonly KeepPartnerId[], run: RunCommand): ResolvedKeepPartner[] {
    const end = clonesProfile.start("keep-partners.resolve");
    const out: ResolvedKeepPartner[] = [];
    for (const id of ids) {
        const stdout = run(CACHE_COMMANDS[id]);
        if (stdout === null) {
            continue;
        }

        const root = stdout.trim();
        if (root.length === 0 || !existsSync(root)) {
            log.info({ id, root }, "keep-partner root does not exist — skipped");
            continue;
        }

        out.push({ id, root });
    }

    const elapsedMs = Math.round(end());
    log.info({ requested: ids, resolved: out.map((r) => r.id), elapsedMs }, "keep partners resolved");
    return out;
}

/** Build the `partnerFor` hook `findDuplicateFiles` calls per bucketed file.
 *  Only bun can map a worktree path to a store path; every other manager is
 *  content-addressed or archive-based and returns nothing. */
export function makePartnerFor(partners: readonly ResolvedKeepPartner[]): (file: string, size: number) => string[] {
    const bunRoots = partners.filter((p) => p.id === "bun").map((p) => p.root);
    if (bunRoots.length === 0) {
        return () => [];
    }

    const dirCache = new Map<string, string[]>();
    const listDir = (dir: string): string[] => {
        const hit = dirCache.get(dir);
        if (hit !== undefined) {
            return hit;
        }

        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch (err) {
            log.debug({ err, dir }, "keep-partner listDir failed");
            entries = [];
        }

        dirCache.set(dir, entries);
        return entries;
    };

    return (file) =>
        measureItem("keep-partners.partnerFor", () => {
            const id = packageIdentityOf(file);
            if (id === null) {
                return [];
            }

            const rel = relative(id.dir, file);
            const out: string[] = [];
            for (const root of bunRoots) {
                out.push(...bunCacheCandidates(root, id, rel, listDir).filter((p) => existsSync(p)));
            }

            return out;
        });
}
