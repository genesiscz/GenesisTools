import {
    type BigIntStats,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmdirSync,
    rmSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type CopyFile, cloneOrCopy } from "@genesiscz/utils/fs/clone";
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
 * name that another start is placing right now, or a folder that another user
 * can write to gets the bun binary itself. In those two cases the caller has
 * no path of its own, so the grant below is not stable for it.
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
 * next use, and that first clone turns the other hard links into clones too.
 *
 * Elsewhere it stays a hard link. Windows and test processes get the bun
 * binary itself: a test home is removed at exit, and removing an executable
 * that just started has crashed syspolicyd (tests.md, "Test traps").
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

        if (kind === "clone") {
            if (!isPrivateDir(binDir)) {
                logger.debug(
                    { binDir },
                    "[bun-link] another user can write to the folder of the names, using the bun binary"
                );
                return bunPath;
            }

            if (isCurrentClone(target, source)) {
                return target;
            }

            const placed = placeClone({ bunPath, source, target, binDir, copyFile, beforePublish });

            if (placed === "busy") {
                return bunPath;
            }

            if (placed === "placed") {
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
/** A lock older than this was left by a start that died: the work under it takes well under a millisecond. */
const LOCK_STALE_MS = 10_000;

const ownUid = (): bigint => BigInt(process.getuid?.() ?? -1);

/**
 * Whether only this user can put a file into `dir` (a folder that does not exist yet is made by this user). The
 * returned path is started as bun, so a folder that another user can write to is never used.
 */
function isPrivateDir(dir: string): boolean {
    const stat = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
    return stat === undefined || (stat.isDirectory() && stat.uid === ownUid() && (stat.mode & OTHERS_MAY_WRITE) === 0n);
}

/**
 * Whether `target` is already a clone of the current bun. The path is started as bun, so it has to be what this code
 * put there: a regular file and no symbolic link, of this user, that nobody else can write to, in a folder nobody
 * else can write to (`isPrivateDir`), on bun's volume (a clone cannot leave it), with one name only (a hard link of
 * bun has more), and with bun's size and modification time, which a clone keeps (checked 2026-11-20). `bun upgrade`
 * writes a new file, so the stamp changes and the clone is made again. Its bytes are not compared: that would read
 * 60 MB on every start. A file that passes all of this was put there by this user, who can replace bun itself too.
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
        stat.size === source.size &&
        stat.mtimeNs === source.mtimeNs
    );
}

/** Takes the lock of one name: a folder, which only one start can make. False while another start holds it. */
function takeLock(lock: string): boolean {
    for (const attempt of [1, 2]) {
        try {
            mkdirSync(lock);
            return true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
                throw err;
            }
        }

        const stat = statSync(lock, { throwIfNoEntry: false });

        if (attempt === 2 || (stat !== undefined && Date.now() - stat.mtimeMs < LOCK_STALE_MS)) {
            return false;
        }

        try {
            rmdirSync(lock);
        } catch (err) {
            logger.debug({ err, lock }, "[bun-link] another start removed the old lock first");
        }
    }

    return false;
}

/**
 * Clones bun beside `target` and renames the clone over it, so a start never sees a half-written file.
 * `unsupported`: this volume cannot clone. The last check and the rename happen under a lock of the name, so two
 * starts never both rename: the second one finds the first one's clone and keeps it, and a binary that may have
 * just started is never replaced. `busy`: another start holds the lock and its clone is not there yet.
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
    mkdirSync(binDir, { recursive: true, mode: 0o755 });
    const tmp = join(binDir, `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    const placement = cloneOrCopy({ source: bunPath, destination: tmp, mode: 0o755, mayCopy: false, copyFile });

    if (placement !== "cloned") {
        return "unsupported";
    }

    const lock = join(binDir, `.${basename(target)}.lock`);

    try {
        beforePublish?.();

        if (!takeLock(lock)) {
            return isCurrentClone(target, source) ? "placed" : "busy";
        }

        try {
            if (!isCurrentClone(target, source)) {
                renameSync(tmp, target);
            }

            return "placed";
        } finally {
            rmdirSync(lock);
        }
    } finally {
        // Gone already when it was renamed into place.
        rmSync(tmp, { force: true });
    }
}

/**
 * Turns every other `gt-*` hard link of bun in `binDir` into a clone, once. A name nobody starts again would keep
 * bun's inode shared, and the kernel would still name every bun process by one of them. About 0.2 ms per name.
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
            const stat = entry.startsWith("gt-") ? statSync(path, { bigint: true, throwIfNoEntry: false }) : undefined;

            if (stat?.ino === source.ino && stat.dev === source.dev) {
                placeClone({ bunPath, source, target: path, binDir, copyFile });
            }
        } catch (err) {
            logger.debug({ err, path }, "[bun-link] could not turn an old hard link of bun into a clone");
        }
    }
}

/** A hard link of bun, made again when bun's inode changed (`bun upgrade` writes a new one). */
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
    if (existsSync(target)) {
        const stat = statSync(target, { bigint: true });

        if (stat.ino === source.ino && stat.dev === source.dev) {
            return;
        }

        unlinkSync(target);
    }

    mkdirSync(binDir, { recursive: true });
    linkSync(bunPath, target);
}
