import { accessSync, chmodSync, constants, copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** The shape of `copyFileSync`, so a caller can hand in a stand-in that sees the flags or makes a clone fail. */
export type CopyFile = (source: string, destination: string, mode: number) => void;

/** How `cloneOrCopy` put the file in place. `declined`: neither a clone nor a copy was allowed and possible. */
export type Placement = "cloned" | "copied" | "declined";

/**
 * A clone or nothing, and never over an existing destination. `COPYFILE_FICLONE` would fall back to a copy by
 * itself, and the caller could then not tell the free clone from a copy that its byte budget has to pay for.
 * Measured 2026-11-01 on Bun: a 512 MB clone takes 0.1 ms on APFS; HFS+ answers ENOTSUP and another volume EXDEV.
 * Bun's plain `copyFileSync` clones on APFS too, but only by choice of its own; this asks for one.
 */
export const CLONE_ONLY = constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL;

/**
 * Puts a private copy of `source` at `destination`, which must not exist yet: a clone where the volume can make one
 * (APFS, btrfs, XFS) and `mayClone` allows it, else a real copy when `mayCopy` allows it. A clone reads and writes
 * no data, and it keeps the old blocks when `source` is later rewritten, so it is a true before-state.
 *
 * 🛑 Never call it for a cloud placeholder: `clonefile(2)` materializes a dataless file before it clones it, which
 * downloads it, and a copy reads it. A clone the I/O policy refused as dataless (EDEADLK) throws rather than copy.
 *
 * Throws when the source is gone, the destination exists, the source is dataless, or the copy itself fails.
 */
export function cloneOrCopy({
    source,
    destination,
    mode,
    mayClone = true,
    mayCopy,
    copyFile = copyFileSync,
}: {
    source: string;
    destination: string;
    mode: number;
    mayClone?: boolean;
    mayCopy: boolean;
    copyFile?: CopyFile;
}): Placement {
    if (mayClone && cloneable(source) && cloned({ source, destination, mode, copyFile })) {
        return "cloned";
    }

    if (!mayCopy) {
        return "declined";
    }

    // `wx`: never through a file or link that is already there. The mode is set at creation, so the bytes are never
    // readable by anyone else, and no flag or extended attribute of the source comes along.
    writeFileSync(destination, readFileSync(source), { mode, flag: "wx" });
    return "copied";
}

/**
 * Whether a clone of `source` could be removed again. A clone carries the source's file flags, and an immutable
 * (Finder "Locked", `uchg`) or append-only file cannot be unlinked, so its clone would stay forever. Node exposes no
 * `st_flags`; `access(W_OK)` refuses both flags with EPERM (checked 2026-11-01), and a write-protected file too,
 * which then gets a real copy.
 */
function cloneable(source: string): boolean {
    try {
        accessSync(source, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function cloned({
    source,
    destination,
    mode,
    copyFile,
}: {
    source: string;
    destination: string;
    mode: number;
    copyFile: CopyFile;
}): boolean {
    try {
        copyFile(source, destination, CLONE_ONLY);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;

        // The source or the destination is the problem, not the volume: a copy would fail the same way, or read a
        // dataless file (EDEADLK) and download it.
        if (code === "ENOENT" || code === "EEXIST" || code === "EDEADLK") {
            throw err;
        }

        // ENOTSUP, EXDEV, ENOSYS, EINVAL: this volume pair cannot clone. The caller copies.
        return false;
    }

    try {
        chmodSync(destination, mode);
        return true;
    } catch {
        // A clone keeps its source's owner, so one this user cannot make private must not stay. When even the unlink
        // fails, this throws, and the caller records the file as not captured.
        unlinkSync(destination);
        return false;
    }
}
