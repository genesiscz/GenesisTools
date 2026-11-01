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

const SEPARATOR = /[/\\]/;

/**
 * Whether `path` lies under a folder a File Provider serves, where any read may reach the provider. Both the path as
 * written and the file it reaches through symlinks and `..` are checked: `~/Dropbox` is a link into
 * `~/Library/CloudStorage`, and `stat`, `copyFileSync` and `git` all follow it.
 */
export function underCloudRoot(path: string): boolean {
    if (CLOUD_ROOT.test(path)) {
        return true;
    }

    const target = resolvedTarget(path);

    return target !== null && CLOUD_ROOT.test(target);
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

/** The `st_flags` bit of a dataless file (sys/stat.h): its content is with the File Provider, not on this disk. */
export const SF_DATALESS = 0x40000000;

/** `ATTR_CMN_FLAGS` in an attrlist's common group: the file's `st_flags`. */
const ATTR_CMN_FLAGS = 0x00040000;
/** `ATTR_BIT_MAP_COUNT`: the five attribute groups of an attrlist. */
const ATTR_BIT_MAP_COUNT = 5;
/** `FSOPT_NOFOLLOW`: a symlink's own attributes, never its target's. */
const FSOPT_NOFOLLOW = 0x00000001;

interface LibSystem {
    getxattr: (path: Buffer, name: Buffer) => number;
    getattrlist: (path: Buffer, attrList: Uint8Array, attrBuf: Uint8Array) => number;
}

let libSystem: LibSystem | null | undefined;

function loadLibSystem(): LibSystem | null {
    if (libSystem !== undefined) {
        return libSystem;
    }

    libSystem = null;

    if (process.platform !== "darwin") {
        return libSystem;
    }

    try {
        const lib = dlopen("/usr/lib/libSystem.B.dylib", {
            getxattr: {
                args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
                returns: FFIType.i64,
            },
            getattrlist: {
                args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32],
                returns: FFIType.i32,
            },
        });
        libSystem = {
            // A null buffer of size 0 asks for the value's size only, so no attribute bytes are read either.
            getxattr: (path, name) => Number(lib.symbols.getxattr(path, name, null, 0, 0, XATTR_NOFOLLOW)),
            getattrlist: (path, attrList, attrBuf) =>
                lib.symbols.getattrlist(path, attrList, attrBuf, attrBuf.length, FSOPT_NOFOLLOW),
        };
    } catch (err) {
        logger.debug({ err }, "[cloud-placeholder] getxattr and getattrlist are not available");
    }

    return libSystem;
}

/** Whether `path` itself (a symlink is not followed) carries the xattr `name`. macOS only; false elsewhere. */
export function hasXattr(path: string, name: string): boolean {
    const lib = loadLibSystem();

    if (!lib) {
        return false;
    }

    return lib.getxattr(Buffer.from(`${path}\0`), Buffer.from(`${name}\0`)) >= 0;
}

/**
 * The `st_flags` of `path` itself (a symlink is not followed), from one `getattrlist(ATTR_CMN_FLAGS)` call: metadata
 * only, so a dataless file is not downloaded. The attrlist and the reply (a u32 length, then the u32 flags) have the
 * same layout on arm64 and x86_64, unlike `struct stat`. Null off macOS or when the call fails.
 */
export function fileFlags(path: string): number | null {
    const lib = loadLibSystem();

    if (!lib) {
        return null;
    }

    const attrList = new Uint8Array(24);
    const view = new DataView(attrList.buffer);
    view.setUint16(0, ATTR_BIT_MAP_COUNT, true);
    view.setUint32(4, ATTR_CMN_FLAGS, true);
    const reply = new Uint8Array(8);

    if (lib.getattrlist(Buffer.from(`${path}\0`), attrList, reply) !== 0) {
        return null;
    }

    return new DataView(reply.buffer).getUint32(4, true);
}

export type CloudPlaceholderKind = "dataless" | "dropbox-stub";

/**
 * Whether the file at `path` is a cloud placeholder, decided from metadata only, so nothing is downloaded:
 * `dataless` for a file with {@link SF_DATALESS}, `dropbox-stub` for a file with {@link DROPBOX_PLACEHOLDER_XATTR}.
 * Bytes in 0 blocks ({@link isDatalessFile}) only make a file a candidate, read with one {@link fileFlags} call: an
 * all-hole sparse file or a `UF_COMPRESSED` (decmpfs) file has neither mark and is a normal file. A dataless file is
 * never asked for its xattrs. Off macOS nothing is a placeholder; where the flags cannot be read, a candidate counts
 * as dataless.
 */
export function cloudPlaceholderKind(
    path: string,
    stat: Pick<Stats, "size" | "blocks" | "isFile">
): CloudPlaceholderKind | null {
    if (!stat.isFile()) {
        return null;
    }

    if (isDatalessFile(stat)) {
        const flags = fileFlags(path);

        if (flags === null || (flags & SF_DATALESS) !== 0) {
            return "dataless";
        }
    }

    return hasXattr(path, DROPBOX_PLACEHOLDER_XATTR) ? "dropbox-stub" : null;
}
