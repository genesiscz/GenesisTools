import {
    type BigIntStats,
    closeSync,
    constants,
    linkSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { aclAllows } from "@genesiscz/utils/fs/acl";
import { canonicalDir } from "@genesiscz/utils/fs/canonical";
import { type CopyFile, cloneOrCopy } from "@genesiscz/utils/fs/clone";
import { foreignAncestor } from "@genesiscz/utils/fs/foreign-ancestor";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { fileNameSlug } from "@genesiscz/utils/string";
import { isTestProcess } from "@genesiscz/utils/test-process";

/**
 * How a `gt-<tool>` name is made. `clone`: a file of its own (an APFS clone of bun). `link`: a hard link of bun.
 * `none`: no name, the bun binary itself.
 */
export type BunNameKind = "clone" | "link" | "none";

/**
 * Resolve a bun executable named after the tool it will run, so the process
 * shows up in Activity Monitor / ps / pgrep as "gt-<name>" instead of "bun".
 *
 * Activity Monitor names a process after its resolved executable file and
 * follows symlinks (verified 2026-08-26), so the name has to be a real file:
 * the same signed bun binary under another path. A parent that is signed
 * (Genesis.app, cmux) and starts `/usr/bin/env bun` is SIGKILLed by Taskgated,
 * so it is always the running interpreter's own binary, never PATH "bun".
 *
 * On macOS each name is an APFS clone with its own inode when the volume can
 * clone. A volume that cannot clone gets a hard link, as before. A failure, a
 * name that another start is placing right now, or a folder of the names that
 * another user can write to or swap (the folder or one above it) gets the bun
 * binary itself. With a hard link or the bun binary the caller has no path of
 * its own, so the grant below is not stable for it.
 * macOS keys a privacy grant (TCC) by the path of the responsible program, and
 * for an inode with many hard links the kernel reports whichever name it
 * resolved last: one bare `bun` process was named `gt-genesis-tools` by tccd
 * and `gt-hub` by lsof four minutes later, so macOS asked again under a tool
 * that did not ask, and "Allow" did not hold (2026-11-20, 372 names on one
 * inode). A clone costs no disk space, takes about 0.2 ms, keeps bun's code
 * signature valid, and macOS keeps its grant when a new clone replaces it at
 * the same path. Its cost: macOS checks each new clone at its first start
 * (about 0.7 s more, once per tool after each bun upgrade). A name that is
 * still a hard link of bun (made by an older version) becomes a clone on its
 * next use, and each start turns the hard links that are left into clones.
 *
 * A process that runs an older bun than a name already holds (a worker that
 * outlived `bun upgrade`) gets its own binary and leaves the name alone.
 *
 * Elsewhere it stays a hard link, in a test process too. Windows gets the bun
 * binary itself, and so does a test process on macOS: a test home is removed
 * at exit, and removing an executable that just started has crashed
 * syspolicyd (tests.md, "Test traps").
 */
export function namedBunExecPath(name: string, bunPath: string = process.execPath): string {
    return placeNamedBun({ name, bunPath, binDir: genesisToolsDir("bin"), kind: defaultBunNameKind() });
}

function defaultBunNameKind(): BunNameKind {
    if (process.platform === "win32") {
        return "none";
    }

    if (process.platform !== "darwin") {
        return "link";
    }

    return isTestProcess() ? "none" : "clone";
}

/** The file name a tool's bun gets: `gt-<name>`, with characters unsafe in a file name replaced by "-". */
export function bunNameFor(name: string): string {
    return `gt-${fileNameSlug(name)}`;
}

/**
 * Puts `<binDir>/gt-<name>` in place as `kind` says and returns its path. Any filesystem failure returns
 * `bunPath`, which only keeps the plain "bun" name. A volume that cannot clone gets a hard link instead.
 * `copyFile` and `beforePublish` exist for tests: a clone that fails, and a second start that wins the race.
 */
export function placeNamedBun({
    name,
    bunPath,
    binDir,
    kind,
    copyFile,
    beforePublish,
}: {
    name: string;
    bunPath: string;
    binDir: string;
    kind: BunNameKind;
    copyFile?: CopyFile;
    beforePublish?: () => void;
}): string {
    if (kind === "none") {
        return bunPath;
    }

    const target = join(binDir, bunNameFor(name));

    try {
        const source = statSync(bunPath, { bigint: true });

        if (isOlderImage({ bunPath, binDir, target, source })) {
            return bunPath;
        }

        if (kind === "clone") {
            // Made first: the check below reads the folder and everything above it.
            mkdirSync(binDir, { recursive: true, mode: 0o755 });

            if (!isPrivateDir(binDir)) {
                logger.debug(
                    { binDir },
                    "[bun-link] another user can write to or swap the folder of the names, using the bun binary"
                );
                return bunPath;
            }

            const placed = isCurrentClone(target, source)
                ? "placed"
                : placeClone({ bunPath, source, target, binDir, copyFile, beforePublish });

            if (placed === "busy") {
                return bunPath;
            }

            if (placed === "placed") {
                // Also on a start that reuses its clone: a name that was busy during an earlier sweep, or that
                // nobody starts again, is still a hard link of bun.
                if (source.nlink > 1n) {
                    cloneOtherHardLinks({ bunPath, source, binDir, copyFile });
                }

                return target;
            }
        }

        placeLink({ bunPath, source, target, binDir });
        return target;
    } catch (err) {
        logger.debug({ err, target }, "[bun-link] naming bun failed, falling back to the bun binary");
        return bunPath;
    }
}

/** Write permission for the group or for everyone. */
const OTHERS_MAY_WRITE = 0o022n;
/** Execute permission for the owner. */
const OWNER_MAY_RUN = 0o100n;
/** One lock file for the folder of the names. It is never removed: a lock file that goes away can be locked twice. */
const LOCK_FILE = ".names.lock";
/** open(2) on macOS: also take an exclusive lock on the file, as flock(2) does. node:fs has no name for this flag. */
const O_EXLOCK = 0x20;

const ownUid = (): bigint => BigInt(process.getuid?.() ?? -1);

/** The name of a temporary file beside `target`, which a rename then puts in its place. */
const tmpBeside = (target: string): string =>
    join(dirname(target), `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);

/**
 * Whether only this user can put a file under a name in `dir`, which has to exist. The returned path is opened
 * later by its name, so nobody else may be able to write to the folder or to swap it: it is a folder of this
 * user that group and others cannot write to, with no access control list that allows anybody anything, and
 * nothing above it can be changed by another user (`foreignAncestor`, which also follows the symbolic links on
 * the way).
 */
function isPrivateDir(dir: string): boolean {
    const stat = lstatSync(dir, { bigint: true });

    return (
        stat.isDirectory() &&
        stat.uid === ownUid() &&
        (stat.mode & OTHERS_MAY_WRITE) === 0n &&
        aclAllows(dir) === false &&
        foreignAncestor(dir) === null
    );
}

/**
 * Whether this process runs an older bun than the name already holds. `bunPath` is then itself one of the names
 * (a worker started as `gt-<tool>`), and a later start has made `target` from an upgraded bun. Such a worker
 * uses its own binary: if it put its old bun under the name, it and every new start would replace the name in
 * turn. The real bun binary is never older in this sense: after a downgrade it replaces the names.
 */
function isOlderImage({
    bunPath,
    binDir,
    target,
    source,
}: {
    bunPath: string;
    binDir: string;
    target: string;
    source: BigIntStats;
}): boolean {
    if (canonicalDir(dirname(bunPath)) !== canonicalDir(binDir)) {
        return false;
    }

    const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    return stat?.isFile() === true && stat.mtimeNs > source.mtimeNs;
}

/**
 * Whether `target` is already a clone of the current bun. The path is started as bun, so it has to be what this
 * code put there: a regular file and no symbolic link, of this user, that this user can run and nobody else can
 * write to (by its mode or by an access control list), in a folder nobody else can write to or swap
 * (`isPrivateDir`), on bun's volume (a clone cannot leave it), with one name only (a hard link of bun has more),
 * and with bun's size and modification time, which a clone keeps (checked 2026-11-20). `bun upgrade` writes a new file, so the stamp changes and the clone is made again.
 * Its bytes are not compared: that would read 60 MB on every start. A file that passes all of this was put there
 * by this user, who can replace bun itself too.
 */
function isCurrentClone(target: string, source: BigIntStats): boolean {
    const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });

    if (stat === undefined) {
        return false;
    }

    return (
        stat.isFile() &&
        stat.nlink === 1n &&
        stat.dev === source.dev &&
        stat.uid === ownUid() &&
        (stat.mode & OTHERS_MAY_WRITE) === 0n &&
        (stat.mode & OWNER_MAY_RUN) !== 0n &&
        stat.size === source.size &&
        stat.mtimeNs === source.mtimeNs &&
        aclAllows(target) === false
    );
}

/**
 * Takes the lock of the folder of the names and returns its open file, or undefined while another start holds it.
 * The kernel keeps the lock for the open file and drops it when the file is closed or the process ends, so a
 * start that died leaves no lock behind and there is nothing to take over. Only a clone is placed under it, and
 * only macOS makes clones, so the macOS flag is enough.
 */
function takeLock(binDir: string): number | undefined {
    try {
        return openSync(
            join(binDir, LOCK_FILE),
            constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK,
            0o600
        );
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
            return undefined;
        }

        throw err;
    }
}

/**
 * Clones bun beside `target` and renames the clone over it, so a start never sees a half-written file.
 * `unsupported`: this volume cannot clone. The last check and the rename happen under the lock of the folder, so
 * two starts never both rename: the second one finds the first one's clone and keeps it, and a binary that may
 * have just started is never replaced. `busy`: the caller uses its own binary, because another start holds the
 * lock and this name is not current yet, or because a start on a newer bun placed the name in the meantime.
 */
function placeClone({
    bunPath,
    source,
    target,
    binDir,
    copyFile,
    beforePublish,
}: {
    bunPath: string;
    source: BigIntStats;
    target: string;
    binDir: string;
    copyFile?: CopyFile;
    beforePublish?: () => void;
}): "placed" | "unsupported" | "busy" {
    const tmp = tmpBeside(target);
    const placement = cloneOrCopy({ source: bunPath, destination: tmp, mode: 0o755, mayCopy: false, copyFile });

    if (placement !== "cloned") {
        return "unsupported";
    }

    try {
        beforePublish?.();
        const lock = takeLock(binDir);

        if (lock === undefined) {
            return isCurrentClone(target, source) ? "placed" : "busy";
        }

        try {
            // Asked again under the lock: a start on a newer bun may have placed the name while this clone was made.
            if (isOlderImage({ bunPath, binDir, target, source })) {
                return "busy";
            }

            if (!isCurrentClone(target, source)) {
                renameSync(tmp, target);
            }

            return "placed";
        } finally {
            closeSync(lock);
        }
    } finally {
        // Gone already when it was renamed into place.
        rmSync(tmp, { force: true });
    }
}

/**
 * Turns every other `gt-*` hard link of bun in `binDir` into a clone. A name nobody starts again would keep bun's
 * inode shared, and the kernel would still name every bun process by one of them. About 0.2 ms per name. A
 * symbolic link to bun is not a hard link and stays what it is.
 */
function cloneOtherHardLinks({
    bunPath,
    source,
    binDir,
    copyFile,
}: {
    bunPath: string;
    source: BigIntStats;
    binDir: string;
    copyFile?: CopyFile;
}): void {
    for (const entry of readdirSync(binDir)) {
        const path = join(binDir, entry);

        try {
            const stat = entry.startsWith("gt-") ? lstatSync(path, { bigint: true, throwIfNoEntry: false }) : undefined;

            if (stat?.ino === source.ino && stat.dev === source.dev) {
                placeClone({ bunPath, source, target: path, binDir, copyFile });
            }
        } catch (err) {
            logger.debug({ err, path }, "[bun-link] could not turn an old hard link of bun into a clone");
        }
    }
}

/**
 * A hard link of bun, made again when bun's inode changed (`bun upgrade` writes a new one). The new link is made
 * beside `target` and renamed over it, so the name is never missing. It needs no lock: two starts that both do
 * this leave the same link. A symbolic link under the name is not a hard link, even one that names bun: it is
 * replaced.
 */
function placeLink({
    bunPath,
    source,
    target,
    binDir,
}: {
    bunPath: string;
    source: BigIntStats;
    target: string;
    binDir: string;
}): void {
    const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });

    if (stat?.ino === source.ino && stat.dev === source.dev) {
        return;
    }

    mkdirSync(binDir, { recursive: true });
    const tmp = tmpBeside(target);

    try {
        linkSync(bunPath, tmp);
        renameSync(tmp, target);
    } finally {
        // Gone already when it was renamed into place. Still there when the rename failed, or when both names
        // were the same file already: such a rename does nothing.
        rmSync(tmp, { force: true });
    }
}
