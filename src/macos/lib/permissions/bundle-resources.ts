import { createHash } from "node:crypto";
import { type Dirent, existsSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dedupeFile, fileAllocatedSize } from "@genesiscz/utils/fs/disk-usage";
import { sha256File } from "@genesiscz/utils/fs/hash";
import { logger } from "@genesiscz/utils/logger";
import { CloneUnsupportedError, cloneFile, getCloneId, getPrivateSize, swapPaths } from "@genesiscz/utils/macos/apfs";

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

type Errors = ShareBundleResourcesReport["errors"];

/** A file, folder or symlink under `Contents/Resources`; what a comparison needs is read the first time it is asked for. */
interface Entry {
    path: string;
    kind: "file" | "dir" | "link";
    /** Bytes of a file; 0 for a folder or a link. */
    size: number;
    /** Where a link points. */
    target?: string;
    /**
     * Permission bits and owner (`<mode>:<uid>:<gid>`) as listed. A folder's digest covers them: the folder swap puts
     * the keeper's clone, with the keeper's modes and owner, in place of the whole folder.
     */
    access?: string;
    /**
     * A folder whose listing, or an entry in it, could not be read, or that holds an entry of another kind (a pipe, a
     * socket). Such a folder is never compared, replaced or counted as a whole; only its readable entries are.
     */
    incomplete?: boolean;
    cloneId?: bigint | null;
    /** null: a folder with an incomplete part, which equals no other folder. */
    digest?: string | null;
    children?: Entry[];
}

/**
 * A copy an interrupted folder swap leaves beside `<name>`: `<name>.gtshare-<pid>-<ms>`, the fresh clone or the replaced
 * copy (the swap is atomic, so `<name>` itself is intact). Before the swap was atomic, two renames could also leave
 * `<name>.gtshare-old-<pid>-<ms>` as the only copy, with `<name>` missing.
 */
const LEFTOVER = /^(.+)\.gtshare-(old-)?\d+-\d+$/;

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
 * clonefile(2) and exchanged with the old copy in one atomic step: 64 ms plus 0.4 s to remove the old copy, against 7 s
 * for the same files one by one (1.5 ms per `dedupeFile`, measured 2026-11-01). Equal means every name, kind, file
 * content and link target, and a folder only part of which could be read is never equal. A folder that differs is
 * entered, and its equal files are shared one by one (`dedupeFile`: verified byte for byte, then an atomic rename).
 * Each file is read at most once per pass. With `apply`, what an interrupted earlier pass left in a later bundle is put
 * right first ({@link recoverInterruptedSwaps}).
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
        for (const [index, bundle] of bundles.entries()) {
            const root: Entry = { path: join(bundle, SHARED_FOLDER), kind: "dir", size: 0 };

            // The first bundle is only read, so only a later one can hold what an interrupted pass left.
            if (apply && index > 0) {
                recoverInterruptedSwaps(root.path, report.errors);
            }

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
    // A link holds no blocks; it counts only as part of its folder's content.
    if (entry.kind === "link") {
        return;
    }

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

            const digest = digestOf(entry, report.errors);
            const match =
                digest === null ? undefined : candidates.find((keeper) => digestOf(keeper, report.errors) === digest);

            if (match) {
                const files = filesUnder(entry, report.errors);
                // The blocks only these files hold, read before the clone replaces them; a filesystem without the
                // attribute reports what each file occupies.
                const bytes = files.reduce(
                    (sum, file) => sum + (getPrivateSize(file.path) ?? fileAllocatedSize(file.path)),
                    0
                );

                if (!pass.apply || replaceWithClone(match, entry, report.errors)) {
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

            report.errors.push({ path: entry.path, message: messageOf(error) });
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

/**
 * Both are clones of one another already: a file by its APFS clone id, a link by its target, a folder when every entry
 * below is. A folder read only in part proves nothing about the part it could not read, so it never is.
 */
function alreadyShared(keeper: Entry, entry: Entry, errors: Errors): boolean {
    if (keeper.kind !== entry.kind) {
        return false;
    }

    if (entry.kind === "link") {
        return keeper.target === entry.target;
    }

    if (entry.kind === "file") {
        const id = cloneIdOf(entry);
        return keeper.size === entry.size && id !== null && id !== 0n && cloneIdOf(keeper) === id;
    }

    const mine = childrenOf(entry, errors);
    const theirs = childrenOf(keeper, errors);

    return (
        !entry.incomplete &&
        !keeper.incomplete &&
        mine.length === theirs.length &&
        mine.every((child, index) => {
            const other = theirs[index];
            return nameOf(other) === nameOf(child) && alreadyShared(other, child, errors);
        })
    );
}

/** True when `entry` now is a clone of `keeper`; false when the file changed since it was read (it stays). */
function replaceWithClone(keeper: Entry, entry: Entry, errors: Errors): boolean {
    if (entry.kind === "file") {
        // dedupeFile checks the bytes once more right before the clone.
        const status = dedupeFile({ keep: keeper.path, replace: entry.path }).status;
        return status === "cloned" || status === "already-cloned";
    }

    // The name LEFTOVER matches, so a pass that dies before removing it has the next pass remove it.
    const aside = `${entry.path}.gtshare-${process.pid}-${Date.now()}`;

    if (statSync(dirname(keeper.path)).dev !== statSync(dirname(entry.path)).dev) {
        throw new CloneUnsupportedError(`${keeper.path} and ${entry.path} are on different volumes`);
    }

    cloneFile(keeper.path, aside);

    try {
        // One atomic exchange: the folder's path holds its own copy or the clone at every moment, also when this
        // process dies here, so a running session never finds the folder missing. `aside` then holds the old copy.
        swapPaths(aside, entry.path);
    } catch (error) {
        rmSync(aside, { recursive: true, force: true });
        throw error;
    }

    try {
        rmSync(aside, { recursive: true, force: true });
    } catch (error) {
        // Reported, so the bundle is not marked done and the next pass removes the old copy.
        errors.push({ path: aside, message: `the replaced copy was not removed: ${messageOf(error)}` });
    }

    return true;
}

/**
 * Puts right what an interrupted pass left under `dir` (a later bundle's `Contents/Resources`), before it is compared:
 * a replaced copy whose name is missing goes back to it, and any other {@link LEFTOVER} is removed. Apply passes run
 * one at a time (under the build lock), so no leftover belongs to a pass still running.
 */
function recoverInterruptedSwaps(dir: string, errors: Errors): void {
    let items: Dirent[];

    try {
        items = readdirSync(dir, { withFileTypes: true });
    } catch {
        // The walk lists the same folder next and reports what failed.
        return;
    }

    for (const item of items) {
        const path = join(dir, item.name);
        const leftover = LEFTOVER.exec(item.name);

        if (!leftover) {
            if (item.isDirectory()) {
                recoverInterruptedSwaps(path, errors);
            }

            continue;
        }

        const original = join(dir, leftover[1]);

        try {
            if (leftover[2] !== undefined && !existsSync(original)) {
                renameSync(path, original);
                logger.warn({ path: original }, "a resource folder an interrupted pass moved aside is back in place");
                recoverInterruptedSwaps(original, errors);
            } else {
                rmSync(path, { recursive: true, force: true });
            }
        } catch (error) {
            errors.push({ path, message: `an interrupted pass's copy was not cleaned up: ${messageOf(error)}` });
        }
    }
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

/**
 * A file's sha256, a link's target; a folder's digest covers every name, kind and content below it, and is null when
 * any part of that tree is incomplete, so a folder read only in part never equals another.
 */
function digestOf(entry: Entry, errors: Errors): string | null {
    if (entry.digest !== undefined) {
        return entry.digest;
    }

    if (entry.kind === "file") {
        entry.digest = sha256File(entry.path);
        return entry.digest;
    }

    if (entry.kind === "link") {
        entry.digest = createHash("sha256")
            .update(entry.target ?? "")
            .digest("hex");
        return entry.digest;
    }

    const children = childrenOf(entry, errors);
    // Stays null when a part of the tree turns out incomplete.
    entry.digest = null;

    if (entry.incomplete) {
        return null;
    }

    // The folder's own access and each entry's: two folders of the same bytes but other modes or owners are not equal,
    // so their files go one by one through dedupeFile, which keeps each target's mode and owner.
    const hash = createHash("sha256").update(`.\0${entry.access ?? ""}\n`);

    for (const child of children) {
        const digest = digestOf(child, errors);

        if (digest === null) {
            return null;
        }

        hash.update(`${nameOf(child)}\0${child.kind}\0${child.access ?? ""}\0${digest}\n`);
    }

    entry.digest = hash.digest("hex");
    return entry.digest;
}

/** The regular files below `entry` (a link holds no blocks). */
function filesUnder(entry: Entry, errors: Errors): Entry[] {
    if (entry.kind === "file") {
        return [entry];
    }

    if (entry.kind === "link") {
        return [];
    }

    return childrenOf(entry, errors).flatMap((child) => filesUnder(child, errors));
}

/**
 * The files, folders and links in `dir`, sorted by name, read once. A listing, a size or a link target that cannot be
 * read is reported and marks `dir` incomplete, and so does an entry of another kind; such an entry is left out.
 */
function childrenOf(dir: Entry, errors: Errors): Entry[] {
    if (dir.children !== undefined) {
        return dir.children;
    }

    let entries: Dirent[] = [];

    try {
        entries = readdirSync(dir.path, { withFileTypes: true });
    } catch (error) {
        // A missing folder (a bundle without Resources) is no error, but it is no listing to compare either.
        dir.incomplete = true;

        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            errors.push({ path: dir.path, message: messageOf(error) });
        }
    }

    dir.children = entries
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .flatMap((item): Entry[] => {
            const path = join(dir.path, item.name);

            try {
                if (item.isDirectory() || item.isSymbolicLink() || item.isFile()) {
                    const st = lstatSync(path);
                    const access = `${(st.mode & 0o7777).toString(8)}:${st.uid}:${st.gid}`;

                    if (item.isDirectory()) {
                        return [{ path, kind: "dir", size: 0, access }];
                    }

                    if (item.isSymbolicLink()) {
                        return [{ path, kind: "link", size: 0, target: readlinkSync(path), access }];
                    }

                    return [{ path, kind: "file", size: st.size, access }];
                }
            } catch (error) {
                errors.push({ path, message: messageOf(error) });
            }

            dir.incomplete = true;
            return [];
        });

    return dir.children;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
