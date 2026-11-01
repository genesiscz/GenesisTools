import { dlopen, FFIType } from "bun:ffi";
import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";

/**
 * Reading the bytes of a cloud placeholder downloads it. A dataless file (Dropbox, Google Drive, OneDrive, the
 * Tresorit Drive mount, iCloud Drive, Desktop and Documents in iCloud) keeps only its metadata on disk, and the first
 * `read` makes the kernel ask the File Provider for the content before the call returns. A `stat` is safe; a copy,
 * a hash or a `tar` is not. Measured 2026-11-01 17:08: the Bash diff hook copied two Dropbox placeholders that an
 * `ls` named, both lost their dataless flag, and the FileProvider log showed the request before the command ran.
 */

/** `~/Library/CloudStorage/<provider>` (File Provider apps) and `~/Library/Mobile Documents` (iCloud Drive). */
const CLOUD_ROOT = /[/\\]Library[/\\](?:CloudStorage|Mobile Documents)(?:[/\\]|$)/;

/** Links followed before the walk gives up, as the kernel does with ELOOP (MAXSYMLINKS is 32 on macOS). */
const MAX_LINKS = 32;

/**
 * The path separators of this platform. A backslash separates only on Windows; on macOS and Linux it is an ordinary
 * filename character, and splitting on it made `/tmp/work\notes` the missing folder `/tmp/work`.
 */
const SEPARATOR = process.platform === "win32" ? /[/\\]/ : /\//;

/**
 * Whether `path` lies under a folder a File Provider serves, where any read may reach the provider. Both the path as
 * written and the file it reaches through symlinks and `..` are checked: `~/Dropbox` is a link into
 * `~/Library/CloudStorage`, and `stat`, `copyFileSync` and `git` all follow it.
 */
export function underCloudRoot(path: string): boolean {
    if (namesCloudRoot(path)) {
        return true;
    }

    const target = resolvedTarget(path);

    return target !== null && namesCloudRoot(target);
}

/**
 * Whether `path` as written names a cloud storage folder or a path below one, without touching the disk. Enough for a
 * path below a folder `underCloudRoot` already passed when no symlink lies between them: git reports a link in a work
 * tree as a link and never a path through it, and the capture's directory walks do not follow one.
 */
export function namesCloudRoot(path: string): boolean {
    return CLOUD_ROOT.test(path);
}

/**
 * The real path of `path`, found with `lstat` and `readlink` alone, or `null` when a component is missing or the links
 * loop. Not `realpathSync`: Bun's opens the target (a mode 000 file fails it with EACCES, Bun 1.4.2, 2026-11-01), and
 * this check exists so that the file is never opened.
 */
function resolvedTarget(path: string): string | null {
    const start = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
    let current = parse(start).root;
    let pending = start.slice(current.length).split(SEPARATOR);
    let links = 0;

    while (pending.length > 0) {
        const [part = "", ...rest] = pending;
        pending = rest;

        if (part === "" || part === ".") {
            continue;
        }

        // `current` holds no link by now, so its parent is the real parent, as the kernel walks it.
        if (part === "..") {
            current = dirname(current);
            continue;
        }

        const next = join(current, part);
        const link = linkOf(next);

        if (link === undefined) {
            return null;
        }

        if (link === null) {
            current = next;
            continue;
        }

        links += 1;

        if (links > MAX_LINKS) {
            return null;
        }

        // An absolute target starts again at its root; a relative one continues from the link's folder.
        const root = isAbsolute(link) ? parse(link).root : "";

        if (root.length > 0) {
            current = root;
        }

        pending = [...link.slice(root.length).split(SEPARATOR), ...pending];
    }

    return current;
}

/** The target of `path` when it is a symlink, `null` when it is not one, `undefined` when it cannot be read. */
function linkOf(path: string): string | null | undefined {
    try {
        return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
    } catch {
        return undefined;
    }
}

/**
 * A file with bytes but no blocks: its content is not on this disk. Node exposes no `st_flags`, so `SF_DATALESS`
 * cannot be read here; zero blocks is its visible half. The same test also matches a sparse all-zero file and a file
 * stored compressed in its extended attributes, which costs those only a skipped read. macOS only: Windows reports
 * no blocks, and no placeholder there looks like this.
 */
export function isDatalessFile(stat: Pick<Stats, "size" | "blocks">): boolean {
    if (process.platform !== "darwin") {
        return false;
    }

    return stat.size > 0 && stat.blocks === 0;
}

/** Why reading `path` could download it from a cloud provider, or `null` when a read stays local. */
export function cloudReadRisk(path: string, stat: Pick<Stats, "size" | "blocks">): string | null {
    if (underCloudRoot(path)) {
        return "under a cloud storage folder, where a read can download it";
    }

    if (isDatalessFile(stat)) {
        return `${stat.size} bytes in 0 blocks, a cloud placeholder that a read would download`;
    }

    return null;
}

/**
 * The xattr the Dropbox app set on an online-only file before it moved to File Provider. Such a file keeps its size,
 * but its bytes on this disk are zeros: the real content is in the cloud copy.
 */
export const DROPBOX_PLACEHOLDER_XATTR = "com.dropbox.placeholder";

/** `XATTR_NOFOLLOW`: a symlink's own attributes, never its target's. */
const XATTR_NOFOLLOW = 0x0001;

type Getxattr = (path: Buffer, name: Buffer) => number;

let getxattr: Getxattr | null | undefined;

function loadGetxattr(): Getxattr | null {
    if (getxattr !== undefined) {
        return getxattr;
    }

    getxattr = null;

    if (process.platform !== "darwin") {
        return getxattr;
    }

    try {
        const lib = dlopen("/usr/lib/libSystem.B.dylib", {
            getxattr: {
                args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
                returns: FFIType.i64,
            },
        });
        // A null buffer of size 0 asks for the value's size only, so no attribute bytes are read either.
        getxattr = (path, name) => Number(lib.symbols.getxattr(path, name, null, 0, 0, XATTR_NOFOLLOW));
    } catch (err) {
        logger.debug({ err }, "[cloud-placeholder] getxattr is not available; no file is seen as a Dropbox stub");
    }

    return getxattr;
}

/** Whether `path` itself (a symlink is not followed) carries the xattr `name`. macOS only; false elsewhere. */
export function hasXattr(path: string, name: string): boolean {
    const call = loadGetxattr();

    if (!call) {
        return false;
    }

    return call(Buffer.from(`${path}\0`), Buffer.from(`${name}\0`)) >= 0;
}

export type CloudPlaceholderKind = "dataless" | "dropbox-stub";

/**
 * Whether the file at `path` is a cloud placeholder, decided from metadata only (its stat and one xattr lookup), so
 * nothing is downloaded: `dataless` for bytes in 0 blocks ({@link isDatalessFile}; a sparse file that is all holes
 * looks the same), `dropbox-stub` for a file with {@link DROPBOX_PLACEHOLDER_XATTR}. A dataless file is never asked
 * for its xattrs.
 */
export function cloudPlaceholderKind(
    path: string,
    stat: Pick<Stats, "size" | "blocks" | "isFile">
): CloudPlaceholderKind | null {
    if (!stat.isFile()) {
        return null;
    }

    if (isDatalessFile(stat)) {
        return "dataless";
    }

    return hasXattr(path, DROPBOX_PLACEHOLDER_XATTR) ? "dropbox-stub" : null;
}
