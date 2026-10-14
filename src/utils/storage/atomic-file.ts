import {
    accessSync,
    chmodSync,
    closeSync,
    constants,
    copyFileSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { assertTestSafePath } from "./real-home-guard";

/**
 * The two calls a full disk fails in. Production never replaces them; tests spy on this object to make a
 * write fail halfway with ENOSPC, which no real test host can produce on demand.
 */
export const atomicWriteIo: {
    writeSync: (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
    fsyncSync: (fd: number) => void;
} = {
    writeSync: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
    fsyncSync,
};

export interface AtomicWriteOptions {
    /**
     * Octal mode (e.g. `0o600`) for the new file. Without it, a replaced file keeps the mode it had, so a
     * 0600 file holding tokens is never republished at the umask default; a new file gets the umask default.
     */
    mode?: number;
    /**
     * Keep the replaced content as `<path>.bak` (one rolling copy) before the rename. Use it for a file that
     * another app owns (`~/.claude.json`, Codex and Grok configs): a write built from a bad read is then
     * still one `mv` away from undone. A failed backup refuses the write.
     */
    backup?: boolean;
}

let tempCounter = 0;

/** Best-effort removal of an abandoned temp file; never masks the failure that caused it. */
function removeTempFile(tmp: string): void {
    try {
        unlinkSync(tmp);
    } catch (cleanupErr) {
        logger.debug({ err: cleanupErr, tmp }, "[storage] tmp-file cleanup after a failed atomic write");
    }
}

function existingMode(filePath: string): number | undefined {
    try {
        return statSync(filePath).mode & 0o777;
    } catch {
        return undefined;
    }
}

/**
 * A symlinked target (`~/.claude/settings.json` points into a dotfiles repo) is written through to the file
 * it names: renaming over the link itself would replace it with a plain file and cut the user's repo off.
 */
function resolveSymlinkTarget(filePath: string): string {
    try {
        return lstatSync(filePath).isSymbolicLink() ? realpathSync(filePath) : filePath;
    } catch {
        return filePath;
    }
}

/** Local time as `YYYYMMDD-HHMMSS-mmm`, for file names that sort by age. */
function fileStamp(date = new Date()): string {
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `${day}-${time}-${pad(date.getMilliseconds(), 3)}`;
}

/** Copy-on-write clone on APFS (no extra space), a plain copy elsewhere. */
function cloneFileSync(from: string, to: string, exclusive: boolean): void {
    copyFileSync(from, to, constants.COPYFILE_FICLONE | (exclusive ? constants.COPYFILE_EXCL : 0));
}

/** A failed refresh of the rolling backup must leave its previous recovery copy intact. */
function publishBackup(from: string, backupPath: string): void {
    const tmp = `${backupPath}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;

    try {
        cloneFileSync(from, tmp, true);
        const fd = openSync(tmp, "r+");

        try {
            atomicWriteIo.fsyncSync(fd);
        } finally {
            closeSync(fd);
        }

        renameSync(tmp, backupPath);
    } catch (error) {
        removeTempFile(tmp);
        throw error;
    }
}

/**
 * Write data to a file atomically: a temp file in the same directory, written in full and fsync'd, then
 * renamed over the target. A failure at any step (ENOSPC halfway through, EACCES, a crash) leaves the
 * target byte-identical and removes the temp file. Safe under concurrent writers: each gets its own temp
 * name and rename is atomic on POSIX.
 *
 * `mode` applies from the temp file's birth, so a file holding secrets is never briefly published at the
 * umask default: the rename carries the restricted mode with it. The open's own mode is masked by umask
 * (umask 0600 yields a 000 file), so it is re-applied to the temp file before it gets the real name.
 * A symlinked target is written through: the link stays, the file it names gets the new content.
 */
export function atomicWriteFileSync(path: string, data: string | Uint8Array, options?: AtomicWriteOptions): void {
    assertTestSafePath(path, "write");

    const filePath = resolveSymlinkTarget(path);

    if (filePath !== path) {
        assertTestSafePath(filePath, "write");
    }

    const dir = dirname(filePath);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // A rename needs write access to the folder only, so it would replace a file the user made read-only.
    // The in-place writes this replaces failed with EACCES there, and so does this.
    if (existsSync(filePath)) {
        accessSync(filePath, constants.W_OK);
    }

    const mode = options?.mode ?? existingMode(filePath);
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;

    // Every step after the temp path may exist shares one cleanup path: a half-written or unchmod'd temp
    // file must never be left behind, least of all when it holds the secret `mode` was requested for.
    try {
        const fd = openSync(tmp, "wx", mode ?? 0o666);

        try {
            const bytes = typeof data === "string" ? Buffer.from(data) : data;
            let offset = 0;

            while (offset < bytes.length) {
                offset += atomicWriteIo.writeSync(fd, bytes, offset, bytes.length - offset);
            }

            // Without it a kernel panic after the rename can publish the new name with no data behind it.
            atomicWriteIo.fsyncSync(fd);
        } finally {
            closeSync(fd);
        }

        if (mode !== undefined) {
            chmodSync(tmp, mode);
        }

        if (options?.backup && existsSync(filePath)) {
            publishBackup(filePath, `${filePath}.bak`);
        }
    } catch (err) {
        removeTempFile(tmp);
        throw err;
    }

    try {
        renameSync(tmp, filePath);
    } catch (err) {
        removeTempFile(tmp);
        // The errno is the whole diagnosis here: EXDEV (tmp and target on different mounts), ENOSPC,
        // EACCES and ENOTEMPTY all need different answers and would otherwise collapse into one message.
        throw new Error(`Atomic rename failed: ${tmp} → ${filePath}`, { cause: err });
    }
}

/**
 * Keep a copy of a file that exists but cannot be used (it does not parse, or has the wrong shape) as
 * `<path>.corrupt-<local time>` next to it, BEFORE anything replaces it. A truncated config is often still
 * most of the user's data. Returns the copy's path. Throws when the copy cannot be made: the caller must
 * then refuse its write, because the original would be the only copy left.
 */
export function preserveUnreadableFile(filePath: string, reason: unknown): string {
    assertTestSafePath(filePath, "copy aside");

    const aside = `${filePath}.corrupt-${fileStamp()}`;
    cloneFileSync(filePath, aside, true);
    // Parser messages can contain the complete credential document. Never interpolate the reason itself.
    const category = reason instanceof SyntaxError ? "invalid JSON" : "invalid data";
    logger.warn(`[storage] ${filePath} could not be used (${category}); kept a copy at ${aside} before replacing it`);
    return aside;
}

export type JsonFileForUpdate<T> =
    | { state: "missing" }
    | { state: "ok"; value: T }
    | { state: "corrupt"; error: unknown; preservedAt: string };

/**
 * Read a JSON file that the caller is about to rewrite. A missing file is `missing`: creating it with
 * defaults is fine. A file that exists but does not parse, or fails `accepts`, is copied aside first
 * ({@link preserveUnreadableFile}) and comes back `corrupt`, so a caller that falls back to defaults can
 * no longer destroy the only copy. A read error that is not about the content (EACCES, EIO) throws: the
 * caller cannot know what it would replace, so it must not write.
 */
export function readJsonFileForUpdateSync<T>(
    filePath: string,
    options?: { accepts?: (value: unknown) => value is T; strict?: boolean }
): JsonFileForUpdate<T> {
    let text: string;

    try {
        text = readFileSync(filePath, "utf8");
    } catch (err) {
        if (isMissingFileError(err)) {
            return { state: "missing" };
        }

        throw err;
    }

    let value: unknown;

    try {
        value = SafeJSON.parse(text, options?.strict ? { strict: true } : undefined);
    } catch (error) {
        return { state: "corrupt", error, preservedAt: preserveUnreadableFile(filePath, error) };
    }

    if (options?.accepts && !options.accepts(value)) {
        const error = new Error("unexpected JSON shape");
        return { state: "corrupt", error, preservedAt: preserveUnreadableFile(filePath, error) };
    }

    return { state: "ok", value: value as T };
}

/**
 * The bytes of a file, or `undefined` when it does not exist. Any other read error (EACCES, EIO) throws: a
 * caller that snapshots a file before replacing it must never mistake "unreadable" for "absent", or its
 * rollback deletes the user's file instead of restoring it.
 */
export function readFileIfExistsSync(filePath: string): Uint8Array | undefined {
    try {
        return readFileSync(filePath);
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return undefined;
        }

        throw err;
    }
}

/**
 * True only for ENOENT, the one read error that means "there is no file yet". EACCES, EIO or EISDIR mean
 * the file's content is unknown, so a caller must not treat the file as empty and write over it.
 */
export function isMissingFileError(err: unknown): boolean {
    return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/** True for a plain JSON object (`{...}`), the shape every config file here has at its root. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
