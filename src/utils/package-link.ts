/**
 * Make `@genesiscz/utils` resolvable for TypeScript files that live OUTSIDE this checkout.
 *
 * The problem this solves is not specific to one tool. Any tool that runs a `.ts` file the
 * user wrote — a generated document module, a resolver script, a codemod, a config that is
 * code rather than data — hits it the moment that file sits somewhere else:
 *
 *     import { defineDocument } from "@genesiscz/utils/json2md/document-file";
 *     // Cannot find package '@genesiscz/utils' imported from /…/some/vault/note.ts
 *
 * Bun resolves a bare specifier from the IMPORTING file's folder, not from the tool's, so
 * nothing the tool does at call time can fix it.
 *
 * The fix is one `tsconfig.json` carrying a `paths` mapping at an ancestor directory. Bun
 * reads the NEAREST tsconfig above the importing file and applies its `paths` before any
 * `node_modules` walk, so a single file answers for every descendant, under plain
 * `bun file.ts` exactly as under a tool.
 *
 * ⚠️ Measured alternatives, all rejected (2026-09-22, Bun 1.4.2):
 *
 * - A `node_modules` symlink works, but an empty or near-empty `node_modules` DISABLES Bun's
 *   auto-install for every file beneath it. `picocolors` resolved from /tmp and failed from
 *   the home directory. That breaks loose scripts that previously ran.
 * - A runtime `Bun.plugin` `onResolve` hook is never consulted for a BARE specifier. Proved
 *   with a positive control: the same plugin's hook fired for a relative specifier in the
 *   same process, and `onLoad` fired for real files, while the bare specifier went straight
 *   to the node resolver.
 * - `bun link` registers a package for later `bun link <name>`; it puts nothing on the
 *   resolution path by itself.
 * - Publishing to npm works, but hands consumers a SNAPSHOT while the repo runs live code.
 *
 * 🛑 The blast radius is bounded by the nearest-tsconfig rule, which is the whole reason this
 * mechanism is safe at the home directory: a project with its OWN tsconfig never sees this
 * mapping. Only files with no tsconfig of their own — loose scripts and vault documents,
 * exactly the target — resolve through it.
 */

import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export const PACKAGE_NAME = "@genesiscz/utils";

/** The wildcard key. Every subpath import goes through it, so it is the authoritative entry. */
const WILDCARD_KEY = `${PACKAGE_NAME}/*`;

/**
 * The package directory of the checkout this code is running from.
 *
 * This module lives AT the package root, so its own directory is the answer. That is what
 * makes the mapping point at the running checkout rather than at a path written down once.
 */
export function utilsPackageDir(): string {
    return import.meta.dir;
}

/** `<root>/tsconfig.json` — the one file this module writes. */
export function configPathFor(root: string): string {
    return join(resolve(root), "tsconfig.json");
}

interface TsConfigShape {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    files?: unknown;
    include?: unknown;
    [key: string]: unknown;
}

type ReadOutcome =
    | { state: "absent" }
    | { state: "parsed"; config: TsConfigShape }
    | { state: "unreadable"; reason: string };

/**
 * Reads the config, preserving comments.
 *
 * `SafeJSON` is comment-json backed, so a tsconfig carrying `//` comments and trailing commas
 * survives a parse/stringify round trip. A hand-written tsconfig usually has both, and
 * silently stripping a user's comments would be a destructive edit disguised as a merge.
 */
function readConfig(configPath: string): ReadOutcome {
    if (!existsSync(configPath)) {
        return { state: "absent" };
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(configPath, "utf8"));

        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { state: "unreadable", reason: "not a JSON object" };
        }

        return { state: "parsed", config: parsed as TsConfigShape };
    } catch (error) {
        return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * The checkout an existing mapping names, as an ABSOLUTE path, or null when there is none.
 *
 * 🛑 A `paths` target is usually written relative, and TypeScript resolves it against
 * `baseUrl` when that is set and against the config file's own directory otherwise. Comparing
 * the raw string to an absolute path reports every relative mapping as another checkout — this
 * repo's own tsconfig says `./src/utils`, and the status table called it "other checkout".
 */
function mappedPackageDir(config: TsConfigShape, configPath: string): string | null {
    const entry = config.compilerOptions?.paths?.[WILDCARD_KEY];
    const first = Array.isArray(entry) ? entry[0] : undefined;

    if (typeof first !== "string" || !first.endsWith("/*")) {
        return null;
    }

    const baseUrl = config.compilerOptions?.baseUrl;
    const configDir = dirname(configPath);
    const base = typeof baseUrl === "string" ? resolve(configDir, baseUrl) : configDir;

    return resolve(base, first.slice(0, -2));
}

/**
 * The nearest `tsconfig.json` at or above `dir`, or null.
 *
 * Bun applies the paths of the NEAREST tsconfig only, never a merge up the chain. That bound
 * is what makes the mapping safe at the home directory, and it is also the single way the
 * mapping fails: a project carrying its own tsconfig hides the ancestor completely.
 */
export function nearestConfigFor(dir: string): string | null {
    let current = resolve(dir);

    for (;;) {
        const candidate = join(current, "tsconfig.json");

        if (existsSync(candidate)) {
            return candidate;
        }

        const parent = dirname(current);

        if (parent === current) {
            return null;
        }

        current = parent;
    }
}

/**
 * The config that HIDES our mapping from files in `dir`, or null.
 *
 * Only a real shadow counts: a nearer config that carries no mapping of ours, while some
 * config above it does. Without this the failure is silent and looks like a broken install,
 * when the fix is simply to run the install against that nearer project instead.
 */
export function shadowedByFor(dir: string): string | null {
    const nearest = nearestConfigFor(dir);

    if (nearest === null) {
        return null;
    }

    const read = readConfig(nearest);

    if (read.state === "parsed" && mappedPackageDir(read.config, nearest) !== null) {
        return null;
    }

    let current = dirname(dirname(nearest));

    for (;;) {
        const candidate = join(current, "tsconfig.json");
        const above = readConfig(candidate);

        if (above.state === "parsed" && mappedPackageDir(above.config, candidate) !== null) {
            return nearest;
        }

        const parent = dirname(current);

        if (parent === current) {
            return null;
        }

        current = parent;
    }
}

/**
 * Whether a bare `@genesiscz/utils` import would resolve for a file in `dir`.
 *
 * 🛑 Accurate only in a process that has NOT just changed the filesystem underneath it. Bun
 * caches module resolution per process, so calling this immediately after writing the config
 * returns the cached miss and reports a correct install as broken. Use `linkIsSound` for that
 * case, and this one from a fresh process such as `status`.
 */
export function packageResolvesFrom(dir: string): boolean {
    try {
        Bun.resolveSync(PACKAGE_NAME, dir);

        return true;
    } catch {
        return false;
    }
}

/**
 * Structural check that a mapping will work, without asking the resolver.
 *
 * The target must be a directory carrying a `package.json` whose `name` is the package. That
 * is what the mapping points at, so it answers the same question the resolver would, and it
 * is immune to the per-process resolution cache.
 */
export function linkIsSound(target: string): boolean {
    const manifest = join(target, "package.json");

    if (!existsSync(manifest)) {
        return false;
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(manifest, "utf8")) as { name?: string };

        return parsed.name === PACKAGE_NAME;
    } catch {
        return false;
    }
}

export type LinkOutcome =
    /** The config did not exist and was written. */
    | "created"
    /** The mapping was added to a config that already existed. */
    | "merged"
    /** It already pointed at this checkout; nothing to do. */
    | "already"
    /** It pointed at a path that no longer exists, and was repointed at this checkout. */
    | "repaired"
    /** It points at another LIVE checkout. Not replaced without `force`. */
    | "points-elsewhere"
    /** A file is there that is not a JSON object. Never overwritten. */
    | "occupied";

export interface LinkResult {
    outcome: LinkOutcome;
    /** `<root>/tsconfig.json`. */
    configPath: string;
    /** Where the mapping points, or would point. */
    target: string;
    /** What was already mapped, when something was. */
    existing?: string;
    /** Whether the specifier actually resolves from `root` now. The only real proof. */
    resolves: boolean;
}

export interface LinkOptions {
    /** Directory to act on. Everything beneath it resolves. Defaults to the home directory. */
    root?: string;
    /** Replace a mapping that points at a different checkout. Never overwrites a foreign file. */
    force?: boolean;
}

/**
 * Writes the ancestor `tsconfig.json` mapping, idempotently.
 *
 * 🛑 Never clobbers. A file that is not a JSON object is reported and left alone. A mapping
 * naming a different LIVE checkout is left alone unless `force` is passed, because silently
 * repointing it would move every consumer beneath that root onto another tree. Every other
 * key in an existing config is preserved, comments included.
 */
export function linkUtilsPackage(options: LinkOptions = {}): LinkResult {
    const root = resolve(options.root ?? homedir());
    const target = utilsPackageDir();
    const configPath = configPathFor(root);
    const read = readConfig(configPath);

    if (read.state === "unreadable") {
        return { outcome: "occupied", configPath, target, existing: read.reason, resolves: false };
    }

    const fresh = read.state === "absent";
    const config: TsConfigShape = read.state === "parsed" ? read.config : {};
    const existing = read.state === "parsed" ? mappedPackageDir(config, configPath) : null;
    let outcome: LinkOutcome = fresh ? "created" : "merged";

    if (existing !== null) {
        if (existing === target) {
            return {
                outcome: "already",
                configPath,
                target,
                existing,
                resolves: linkIsSound(target) && packageResolvesFrom(root),
            };
        }

        // A mapping whose target no longer exists is not another install, it is a stale one:
        // the checkout it named was moved or deleted. Repointing it needs no confirmation,
        // because nothing can depend on a path that is not there. `src/scripts/lib/store.ts`
        // heals its generated tsconfig the same way, for the same reason.
        if (!existsSync(existing)) {
            outcome = "repaired";
        } else if (options.force !== true) {
            return {
                outcome: "points-elsewhere",
                configPath,
                target,
                existing,
                resolves: linkIsSound(existing) && packageResolvesFrom(root),
            };
        }
    }

    const compilerOptions = config.compilerOptions ?? {};
    const paths = compilerOptions.paths ?? {};

    paths[PACKAGE_NAME] = [join(target, "index.ts")];
    paths[WILDCARD_KEY] = [join(target, "*")];
    compilerOptions.paths = paths;
    config.compilerOptions = compilerOptions;

    // 🛑 An editor's TypeScript server treats the directory holding a tsconfig as a project
    // root and indexes every file beneath it. At the home directory that is the whole machine.
    // Empty `files` and `include` say "this project contains no files", which costs Bun
    // nothing: it reads `compilerOptions.paths` and ignores both (measured 2026-09-22).
    // Only set on a config we are creating — a real project's own `include` is not ours.
    if (fresh) {
        config.files = [];
        config.include = [];
    }

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${SafeJSON.stringify(config, null, 4)}\n`);

    return {
        outcome,
        configPath,
        target,
        existing: existing ?? undefined,
        // Structural, not resolver-based: this function just wrote the config, and Bun would
        // still be serving the cached miss from before it existed.
        resolves: linkIsSound(target),
    };
}

export interface LinkStatus {
    root: string;
    configPath: string;
    /** What the running checkout would map to. */
    target: string;
    /** Where the mapping points now, or null when there is none. */
    pointsAt: string | null;
    /** True when a file is there that this tool cannot safely edit. */
    occupied: boolean;
    /** True when the mapping names a path that no longer exists. `install` repairs it. */
    dangling: boolean;
    /** Whether `pointsAt` matches this checkout. */
    current: boolean;
    /** Whether a bare import actually resolves from `root`. The only claim that matters. */
    resolves: boolean;
    /** The tsconfig Bun will actually read for files in this root. */
    nearestConfig: string | null;
    /** Set when a nearer tsconfig hides the mapping. Naming it IS the fix. */
    shadowedBy: string | null;
}

/** Reads the mapping state for one root without changing anything. */
export function linkStatusFor(root: string): LinkStatus {
    const absoluteRoot = resolve(root);
    const target = utilsPackageDir();
    const configPath = configPathFor(absoluteRoot);
    const read = readConfig(configPath);
    const pointsAt = read.state === "parsed" ? mappedPackageDir(read.config, configPath) : null;

    return {
        root: absoluteRoot,
        configPath,
        target,
        pointsAt,
        occupied: read.state === "unreadable",
        dangling: pointsAt !== null && !existsSync(pointsAt),
        current: pointsAt === target,
        // ⚠️ Deliberately independent of the mapping: a repo with its own node_modules
        // resolves without one, and reporting "not installed" there would be true but useless.
        resolves: packageResolvesFrom(absoluteRoot),
        nearestConfig: nearestConfigFor(absoluteRoot),
        shadowedBy: shadowedByFor(absoluteRoot),
    };
}

export type UnlinkOutcome =
    /** The mapping was removed. */
    | "removed"
    /** There was nothing of ours to remove. */
    | "absent"
    /** A file is there that is not a JSON object. Never touched. */
    | "occupied"
    /** The mapping names a DIFFERENT checkout. Not removed without `force`. */
    | "points-elsewhere";

export interface UnlinkResult {
    outcome: UnlinkOutcome;
    configPath: string;
    existing?: string;
    /** True when a `node_modules` symlink from the earlier mechanism was cleaned up too. */
    legacyRemoved: boolean;
    /** True when the config held nothing else and the file itself was removed. */
    configRemoved: boolean;
}

/**
 * Removes the `node_modules` symlink the FIRST version of this tool installed, plus the empty
 * directories it leaves behind.
 *
 * 🛑 An empty `node_modules` is not harmless leftover. Bun stops auto-installing packages for
 * every file beneath a directory that has one, so a husk at the home directory breaks loose
 * scripts that used to run (measured 2026-09-22: `picocolors` resolved from /tmp and failed
 * from the home directory). Pruning the directories is part of the removal, not tidiness.
 */
function removeLegacySymlink(root: string, force: boolean): boolean {
    const modulesDir = join(root, "node_modules");
    const scopeDir = join(modulesDir, PACKAGE_NAME.split("/")[0] as string);
    const linkPath = join(scopeDir, PACKAGE_NAME.split("/")[1] as string);

    try {
        if (!lstatSync(linkPath).isSymbolicLink()) {
            return false;
        }

        // `readlinkSync` returns the link exactly as stored, and a package manager stores it
        // relative to the link's own directory. Comparing that raw string against an absolute
        // target reads every relative link as belonging to a different checkout.
        const points = resolve(dirname(linkPath), readlinkSync(linkPath));

        if (points !== utilsPackageDir() && !force) {
            return false;
        }

        rmSync(linkPath, { force: true });
    } catch {
        return false;
    }

    for (const dir of [scopeDir, modulesDir]) {
        try {
            if (readdirSync(dir).length === 0) {
                rmdirSync(dir);
            }
        } catch {
            // Not empty, or not there. Either way it is not ours to remove.
        }
    }

    return true;
}

/** True when nothing but our own scaffolding is left, so the file itself can go. */
function isScaffoldOnly(config: TsConfigShape): boolean {
    for (const [key, value] of Object.entries(config)) {
        if (key === "files" || key === "include") {
            if (Array.isArray(value) && value.length === 0) {
                continue;
            }

            return false;
        }

        if (key !== "compilerOptions") {
            return false;
        }

        const options = value as { paths?: Record<string, string[]> } | undefined;

        if (options === undefined) {
            continue;
        }

        const rest = Object.entries(options).filter(([name]) => name !== "paths");

        if (rest.length > 0 || Object.keys(options.paths ?? {}).length > 0) {
            return false;
        }
    }

    return true;
}

/**
 * Removes the mapping this module wrote.
 *
 * 🛑 Only ever removes OUR two keys, and by default only when they name this checkout. Every
 * other key, and every comment, survives. The file itself is removed only when nothing but
 * empty scaffolding is left, so a real project config is never deleted.
 */
export function unlinkUtilsPackage(options: LinkOptions = {}): UnlinkResult {
    const root = resolve(options.root ?? homedir());
    const configPath = configPathFor(root);
    const force = options.force === true;
    const legacyRemoved = removeLegacySymlink(root, force);
    const read = readConfig(configPath);

    if (read.state === "unreadable") {
        return { outcome: "occupied", configPath, existing: read.reason, legacyRemoved, configRemoved: false };
    }

    const existing = read.state === "parsed" ? mappedPackageDir(read.config, configPath) : null;

    if (existing === null) {
        return {
            outcome: legacyRemoved ? "removed" : "absent",
            configPath,
            legacyRemoved,
            configRemoved: false,
        };
    }

    if (existing !== utilsPackageDir() && !force) {
        return { outcome: "points-elsewhere", configPath, existing, legacyRemoved, configRemoved: false };
    }

    const config = (read as { config: TsConfigShape }).config;
    const paths = config.compilerOptions?.paths;

    if (paths !== undefined) {
        delete paths[PACKAGE_NAME];
        delete paths[WILDCARD_KEY];

        if (Object.keys(paths).length === 0) {
            delete config.compilerOptions?.paths;
        }
    }

    if (config.compilerOptions !== undefined && Object.keys(config.compilerOptions).length === 0) {
        delete config.compilerOptions;
    }

    const configRemoved = isScaffoldOnly(config);

    if (configRemoved) {
        rmSync(configPath, { force: true });
    } else {
        writeFileSync(configPath, `${SafeJSON.stringify(config, null, 4)}\n`);
    }

    return { outcome: "removed", configPath, existing, legacyRemoved, configRemoved };
}
