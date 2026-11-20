import { type BigIntStats, existsSync, linkSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { type CopyFile, cloneOrCopy } from "@genesiscz/utils/fs/clone";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
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
 * On macOS each name is an APFS clone with its own inode, never a hard link.
 * macOS keys a privacy grant (TCC) by the path of the responsible program, and
 * for an inode with many hard links the kernel reports whichever name it
 * resolved last: one bare `bun` process was named `gt-genesis-tools` by tccd
 * and `gt-hub` by lsof four minutes later, so macOS asked again under a tool
 * that did not ask, and "Allow" did not hold (2026-11-20, 372 names on one
 * inode). A clone costs no disk space, takes about 0.2 ms, keeps bun's code
 * signature valid, and macOS keeps its grant when a new clone replaces it at
 * the same path. Its cost: macOS checks each new clone at its first start
 * (about 0.7 s more, once per tool after each bun upgrade).
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
    return `gt-${name.replace(/[^\w.-]+/g, "-")}`;
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

        if (kind === "clone" && placeClone({ bunPath, source, target, binDir, copyFile, beforePublish })) {
            return target;
        }

        placeLink({ bunPath, source, target, binDir });
        return target;
    } catch (err) {
        logger.debug({ err, target }, "[bun-link] naming bun failed, falling back to the bun binary");
        return bunPath;
    }
}

/**
 * Whether `target` is already a clone of the current bun: one name only (a hard link of bun has more), and bun's
 * size and modification time, which a clone keeps (checked 2026-11-20). `bun upgrade` writes a new file, so the
 * stamp changes and the clone is made again.
 */
function isCurrentClone(target: string, source: BigIntStats): boolean {
    const stat = statSync(target, { bigint: true, throwIfNoEntry: false });
    return stat !== undefined && stat.nlink === 1n && stat.size === source.size && stat.mtimeNs === source.mtimeNs;
}

/**
 * Clones bun beside `target` and renames the clone over it, so a start never sees a half-written file. False when
 * this volume cannot clone. When another start published a current clone while this one cloned, that one stays and
 * this one goes: a binary that may have just started is never replaced.
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
}): boolean {
    if (isCurrentClone(target, source)) {
        return true;
    }

    mkdirSync(binDir, { recursive: true });
    const tmp = join(binDir, `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    const placement = cloneOrCopy({ source: bunPath, destination: tmp, mode: 0o755, mayCopy: false, copyFile });

    if (placement !== "cloned") {
        return false;
    }

    try {
        beforePublish?.();

        if (isCurrentClone(target, source)) {
            unlinkSync(tmp);
            return true;
        }

        renameSync(tmp, target);
        return true;
    } catch (err) {
        unlinkSync(tmp);
        throw err;
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
