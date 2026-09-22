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
 * nothing the tool does at call time can fix it. A `Bun.plugin` `onResolve` hook does not
 * help either: resolution happens before a runtime plugin sees the specifier (measured
 * 2026-09-22 — the plugin's hook is never called for this case).
 *
 * What does work is the ordinary resolution algorithm itself. It walks UP from the importing
 * file looking for `node_modules/<package>`, so ONE symlink at an ancestor directory answers
 * for every file beneath it, under plain `bun file.ts` exactly as under a tool. Linking at the
 * home directory covers everything; linking at a narrower root keeps the blast radius small.
 *
 * ⚠️ It is machine-wide within that root. A project beneath it with no closer `node_modules`
 * entry will now resolve `@genesiscz/utils` where it previously failed, which can mask a
 * genuinely missing dependency. Prefer the narrowest root that covers the files you need.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export const PACKAGE_NAME = "@genesiscz/utils";

/**
 * The package directory of the checkout this code is running from.
 *
 * This module lives AT the package root, so its own directory is the answer. That is what
 * makes the link point at the running checkout rather than at a path written down once.
 */
export function utilsPackageDir(): string {
    return import.meta.dir;
}

/**
 * Where a symlink actually points, as an absolute path.
 *
 * `readlinkSync` returns the link EXACTLY as stored, and a link created by a package manager
 * is usually relative (`../../src/utils`). Comparing that raw string against an absolute
 * target reports every relative link as belonging to a different checkout.
 */
function linkTarget(linkPath: string): string {
    const raw = readlinkSync(linkPath);

    return resolve(dirname(linkPath), raw);
}

/**
 * Whether a bare `@genesiscz/utils` import would resolve for a file in `dir`.
 *
 * 🛑 Accurate only in a process that has NOT just changed the filesystem underneath it. Bun
 * caches module resolution per process, so calling this immediately after creating the link
 * returns the cached miss and reports a correct install as broken. Use `linkIsSound` for
 * that case, and this one from a fresh process such as `status`.
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
 * Structural check that a link will work, without asking the resolver.
 *
 * The target must be a directory carrying a `package.json` whose `name` is the package.
 * That is exactly what node resolution looks for, so it answers the same question the
 * resolver would, and it is immune to the per-process resolution cache.
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
    /** The symlink was created. */
    | "created"
    /** It already pointed at this checkout; nothing to do. */
    | "already"
    /** A symlink is there but points somewhere else. Not replaced without `force`. */
    | "points-elsewhere"
    /** A real file or directory is there. Never replaced. */
    | "occupied";

export interface LinkResult {
    outcome: LinkOutcome;
    /** `<root>/node_modules/@genesiscz/utils`. */
    linkPath: string;
    /** Where it points, or would point. */
    target: string;
    /** What was already there, when something was. */
    existing?: string;
    /** Whether the specifier actually resolves from `root` now. The only real proof. */
    resolves: boolean;
}

export interface LinkOptions {
    /** Directory to link under. Everything beneath it resolves. Defaults to the home directory. */
    root?: string;
    /** Replace a symlink that points somewhere else. Never replaces a real directory. */
    force?: boolean;
}

/**
 * Creates the ancestor `node_modules` symlink, idempotently.
 *
 * 🛑 Never clobbers. A real directory or file at the target path is reported and left alone:
 * something else put it there and this function does not know what depends on it. A symlink
 * pointing at a different checkout is also left alone unless `force` is passed, because
 * silently repointing it would move every consumer beneath that root onto another tree.
 */
export function linkUtilsPackage(options: LinkOptions = {}): LinkResult {
    const root = resolve(options.root ?? homedir());
    const target = utilsPackageDir();
    const scopeDir = join(root, "node_modules", PACKAGE_NAME.split("/")[0] as string);
    const linkPath = join(scopeDir, PACKAGE_NAME.split("/")[1] as string);
    const finish = (outcome: LinkOutcome, existing?: string): LinkResult => ({
        outcome,
        linkPath,
        target,
        existing,
        // Structural, not resolver-based: this function may have just created the symlink,
        // and Bun would still be serving the cached miss from before it existed.
        resolves: linkIsSound(target) && (outcome === "created" || packageResolvesFrom(root)),
    });

    let existing: string | undefined;

    try {
        const stat = lstatSync(linkPath);

        if (!stat.isSymbolicLink()) {
            return finish("occupied", "a real file or directory");
        }

        existing = linkTarget(linkPath);

        if (existing === target) {
            return finish("already", existing);
        }

        if (options.force !== true) {
            return finish("points-elsewhere", existing);
        }
    } catch {
        // Nothing there, which is the ordinary case.
    }

    mkdirSync(scopeDir, { recursive: true });

    if (existing !== undefined) {
        // Only reached with `force`, and only for a symlink whose target was just read.
        rmSync(linkPath, { force: true });
    }

    symlinkSync(target, linkPath, "dir");

    return finish("created", existing);
}

export interface LinkStatus {
    root: string;
    linkPath: string;
    /** What the running checkout would link to. */
    target: string;
    /** Where the link points now, or null when there is no link. */
    pointsAt: string | null;
    /** True when something is there that is not a symlink. */
    occupied: boolean;
    /** Whether `pointsAt` matches this checkout. */
    current: boolean;
    /** Whether a bare import actually resolves from `root`. The only claim that matters. */
    resolves: boolean;
}

/** Reads the link state for one root without changing anything. */
export function linkStatusFor(root: string): LinkStatus {
    const absoluteRoot = resolve(root);
    const target = utilsPackageDir();
    const linkPath = join(absoluteRoot, "node_modules", ...PACKAGE_NAME.split("/"));

    let pointsAt: string | null = null;
    let occupied = false;

    try {
        const stat = lstatSync(linkPath);

        if (stat.isSymbolicLink()) {
            pointsAt = linkTarget(linkPath);
        } else {
            occupied = true;
        }
    } catch {
        // No entry, which is the ordinary "not installed" case.
    }

    return {
        root: absoluteRoot,
        linkPath,
        target,
        pointsAt,
        occupied,
        current: pointsAt === target,
        // ⚠️ Deliberately independent of the link: a repo with its own node_modules resolves
        // without one, and reporting "not installed" there would be true but useless.
        resolves: packageResolvesFrom(absoluteRoot),
    };
}

export type UnlinkOutcome =
    /** The symlink was removed. */
    | "removed"
    /** Nothing was there. */
    | "absent"
    /** A real file or directory is there. Never removed. */
    | "occupied"
    /** A symlink pointing at a DIFFERENT checkout. Not removed without `force`. */
    | "points-elsewhere";

export interface UnlinkResult {
    outcome: UnlinkOutcome;
    linkPath: string;
    existing?: string;
}

/**
 * Removes the symlink this module created.
 *
 * 🛑 Only ever removes a SYMLINK, and by default only one pointing at this checkout. A real
 * directory is someone's installed dependency; a symlink to another checkout belongs to
 * another install. Neither is ours to delete.
 */
export function unlinkUtilsPackage(options: LinkOptions = {}): UnlinkResult {
    const root = resolve(options.root ?? homedir());
    const linkPath = join(root, "node_modules", ...PACKAGE_NAME.split("/"));

    try {
        const stat = lstatSync(linkPath);

        if (!stat.isSymbolicLink()) {
            return { outcome: "occupied", linkPath, existing: "a real file or directory" };
        }

        const existing = linkTarget(linkPath);

        if (existing !== utilsPackageDir() && options.force !== true) {
            return { outcome: "points-elsewhere", linkPath, existing };
        }

        rmSync(linkPath, { force: true });

        return { outcome: "removed", linkPath, existing };
    } catch {
        return { outcome: "absent", linkPath };
    }
}
