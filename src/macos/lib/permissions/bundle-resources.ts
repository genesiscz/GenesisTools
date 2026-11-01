import { createHash } from "node:crypto";
import { type Dirent, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dedupeFile, fileAllocatedSize } from "@genesiscz/utils/fs/disk-usage";
import { sha256File } from "@genesiscz/utils/fs/hash";
import { logger } from "@genesiscz/utils/logger";
import { CloneUnsupportedError, cloneFile, getCloneId, getPrivateSize } from "@genesiscz/utils/macos/apfs";

/**
 * The only folder of a bundle this module changes. A running launcher maps nothing of its bundle but
 * `Contents/MacOS/GenesisTools`, and the signature check macOS runs on a live process (tccd, the keychain) reads that
 * executable, `Info.plist` and `_CodeSignature/CodeResources` by path, so none of those is ever replaced. A resource
 * replaced by a clone of the same bytes keeps the seal, so even a full `codesign --verify` of the bundle still passes.
 */
const SHARED_FOLDER = join("Contents", "Resources");

export interface ShareBundleResourcesReport {
    /** Bundles given, the first one only read. */
    bundles: number;
    /** Regular files seen under `Contents/Resources`. */
    files: number;
    /** Files that are (dry run: would be) replaced by a clone of an earlier bundle's identical file. */
    shared: number;
    /** What those files held on their own before the clone: the space it frees. */
    sharedBytes: number;
    /** Files that were already a clone of their earlier copy. */
    alreadyShared: number;
    errors: { path: string; message: string }[];
    ms: number;
}

/** A file or folder under `Contents/Resources`; what a comparison needs is read the first time it is asked for. */
interface Entry {
    path: string;
    kind: "file" | "dir";
    /** Bytes of a file; 0 for a folder. */
    size: number;
    cloneId?: bigint | null;
    digest?: string;
    children?: Entry[];
}

interface Pass {
    apply: boolean;
    report: ShareBundleResourcesReport;
    /** Earlier entries by their path under `Contents/Resources`, one per distinct content seen. */
    keepers: Map<string, Entry[]>;
}

/**
 * Makes the resources of `bundles` share their blocks: an entry under `Contents/Resources` whose content equals the
 * entry at the same relative path in an EARLIER bundle of the list becomes an APFS clone of it. The first bundle is the
 * reference and is only read. With `apply: false` nothing changes and the report says what would be shared.
 *
 * It works on the largest equal unit. A folder equal as a whole (the 4,646 Clicky sounds) is cloned with one
 * clonefile(2) and swapped in: 64 ms plus 0.4 s to remove the old copy, against 7 s for the same files one by one
 * (1.5 ms per `dedupeFile`, measured 2026-11-01). A folder that differs is entered, and its equal files are shared one
 * by one (`dedupeFile`: verified byte for byte, then an atomic rename). Each file is read at most once per pass.
 *
 * Every retired bundle a running launcher pins used to keep its own 65 MB copy of the same Clicky sounds, web viewers
 * and icon (2026-11-01: 22 pinned folders, 3.1% of their blocks shared).
 */
export function shareBundleResources({
    bundles,
    apply,
}: {
    bundles: string[];
    apply: boolean;
}): ShareBundleResourcesReport {
    const startedAt = performance.now();
    const report: ShareBundleResourcesReport = {
        bundles: bundles.length,
        files: 0,
        shared: 0,
        sharedBytes: 0,
        alreadyShared: 0,
        errors: [],
        ms: 0,
    };
    const pass: Pass = { apply, report, keepers: new Map() };

    try {
        for (const bundle of bundles) {
            const root: Entry = { path: join(bundle, SHARED_FOLDER), kind: "dir", size: 0 };

            for (const child of childrenOf(root, report.errors)) {
                visit(child, nameOf(child), pass);
            }
        }
    } catch (error) {
        if (!(error instanceof CloneUnsupportedError)) {
            throw error;
        }

        report.errors.push({ path: bundles[0] ?? "", message: error.message });
        logger.warn({ error }, "bundle resources not shared: clones do not work here");
    } finally {
        report.ms = Math.round(performance.now() - startedAt);
        logger.debug(
            { ...report, errors: report.errors.length, firstError: report.errors[0], apply },
            "bundle resources shared"
        );
    }

    return report;
}

function visit(entry: Entry, rel: string, pass: Pass): void {
    const { report } = pass;
    const known = pass.keepers.get(rel) ?? [];
    const candidates = known.filter(
        (keeper) => keeper.kind === entry.kind && (entry.kind === "dir" || keeper.size === entry.size)
    );

    // An empty file holds no blocks, so there is nothing to share.
    if (entry.kind === "file" && entry.size === 0) {
        report.files += 1;
        return;
    }

    if (candidates.length > 0) {
        try {
            if (candidates.some((keeper) => alreadyShared(keeper, entry, report.errors))) {
                const files = filesUnder(entry, report.errors);
                report.files += files.length;
                report.alreadyShared += files.length;
                return;
            }

            const match = candidates.find(
                (keeper) => digestOf(keeper, report.errors) === digestOf(entry, report.errors)
            );

            if (match) {
                const files = filesUnder(entry, report.errors);
                // The blocks only these files hold, read before the clone replaces them; a filesystem without the
                // attribute reports what each file occupies.
                const bytes = files.reduce(
                    (sum, file) => sum + (getPrivateSize(file.path) ?? fileAllocatedSize(file.path)),
                    0
                );

                if (!pass.apply || replaceWithClone(match, entry)) {
                    report.files += files.length;
                    report.shared += files.length;
                    report.sharedBytes += bytes;
                    return;
                }
            }
        } catch (error) {
            if (error instanceof CloneUnsupportedError) {
                throw error;
            }

            report.errors.push({ path: entry.path, message: error instanceof Error ? error.message : String(error) });
        }
    }

    pass.keepers.set(rel, [...known, entry]);

    if (entry.kind === "file") {
        report.files += 1;
        return;
    }

    for (const child of childrenOf(entry, report.errors)) {
        visit(child, `${rel}/${nameOf(child)}`, pass);
    }
}

/** Both are clones of one another already: a file by its APFS clone id, a folder when every entry below is. */
function alreadyShared(keeper: Entry, entry: Entry, errors: ShareBundleResourcesReport["errors"]): boolean {
    if (keeper.kind !== entry.kind) {
        return false;
    }

    if (entry.kind === "file") {
        const id = cloneIdOf(entry);
        return keeper.size === entry.size && id !== null && id !== 0n && cloneIdOf(keeper) === id;
    }

    const mine = childrenOf(entry, errors);
    const theirs = childrenOf(keeper, errors);

    return (
        mine.length === theirs.length &&
        mine.every((child, index) => {
            const other = theirs[index];
            return nameOf(other) === nameOf(child) && alreadyShared(other, child, errors);
        })
    );
}

/** True when `entry` now is a clone of `keeper`; false when the file changed since it was read (it stays). */
function replaceWithClone(keeper: Entry, entry: Entry): boolean {
    if (entry.kind === "file") {
        // dedupeFile checks the bytes once more right before the clone.
        const status = dedupeFile({ keep: keeper.path, replace: entry.path }).status;
        return status === "cloned" || status === "already-cloned";
    }

    const stamp = `${process.pid}-${Date.now()}`;
    const fresh = `${entry.path}.gtshare-${stamp}`;
    const old = `${entry.path}.gtshare-old-${stamp}`;

    if (statSync(dirname(keeper.path)).dev !== statSync(dirname(entry.path)).dev) {
        throw new CloneUnsupportedError(`${keeper.path} and ${entry.path} are on different volumes`);
    }

    cloneFile(keeper.path, fresh);
    renameSync(entry.path, old);

    try {
        renameSync(fresh, entry.path);
    } catch (error) {
        renameSync(old, entry.path);
        rmSync(fresh, { recursive: true, force: true });
        throw error;
    }

    try {
        rmSync(old, { recursive: true, force: true });
    } catch (error) {
        logger.warn({ error, old }, "the replaced copy of a shared resource folder was not removed");
    }

    return true;
}

function nameOf(entry: Entry): string {
    return basename(entry.path);
}

function cloneIdOf(entry: Entry): bigint | null {
    if (entry.cloneId === undefined) {
        entry.cloneId = getCloneId(entry.path);
    }

    return entry.cloneId;
}

/** A file's sha256; a folder's digest covers every name, kind and content below it. */
function digestOf(entry: Entry, errors: ShareBundleResourcesReport["errors"]): string {
    if (entry.digest !== undefined) {
        return entry.digest;
    }

    if (entry.kind === "file") {
        entry.digest = sha256File(entry.path);
        return entry.digest;
    }

    const hash = createHash("sha256");

    for (const child of childrenOf(entry, errors)) {
        hash.update(`${nameOf(child)}\0${child.kind}\0${digestOf(child, errors)}\n`);
    }

    entry.digest = hash.digest("hex");
    return entry.digest;
}

function filesUnder(entry: Entry, errors: ShareBundleResourcesReport["errors"]): Entry[] {
    if (entry.kind === "file") {
        return [entry];
    }

    return childrenOf(entry, errors).flatMap((child) => filesUnder(child, errors));
}

/** The files and folders in `dir`, sorted by name, read once; symlinks and other kinds are skipped. */
function childrenOf(dir: Entry, errors: ShareBundleResourcesReport["errors"]): Entry[] {
    if (dir.children !== undefined) {
        return dir.children;
    }

    let entries: Dirent[] = [];

    try {
        entries = readdirSync(dir.path, { withFileTypes: true });
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            errors.push({ path: dir.path, message: error instanceof Error ? error.message : String(error) });
        }
    }

    dir.children = entries
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .flatMap((item): Entry[] => {
            const path = join(dir.path, item.name);

            if (item.isDirectory()) {
                return [{ path, kind: "dir", size: 0 }];
            }

            if (!item.isFile()) {
                return [];
            }

            try {
                return [{ path, kind: "file", size: statSync(path).size }];
            } catch (error) {
                errors.push({ path, message: error instanceof Error ? error.message : String(error) });
                return [];
            }
        });

    return dir.children;
}
