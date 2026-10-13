import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { cPath, errnoNow, type LibSystem, libSystem, O_CLOEXEC, O_DIRECTORY, O_NONBLOCK } from "./libsystem";

export interface FastWalkOptions {
    /** Absolute roots. A root that is a link is followed; links below a root are returned and not followed. */
    roots: string[];
    /** The root is depth 0; a directory deeper than this is not entered. Unset: no limit. */
    maxDepth?: number;
    /**
     * Return files with exactly one of these names, for example `["chat_history.jsonl"]`. With `endsWith` too, a
     * file that matches either is returned. Neither set: every file is returned.
     */
    names?: string[];
    /** Return files whose name ends with one of these, for example `[".jsonl"]` for every JSONL file. */
    endsWith?: string[];
    /** Also return every directory that was found, with its mtime. */
    includeDirectories?: boolean;
    /** `auto` (default) uses the native walker on macOS and falls back to the JS walker. */
    engine?: "auto" | "native" | "js";
}

export interface FastWalkEntry {
    kind: "file" | "directory" | "link";
    path: string;
    mtimeMs: number;
    /** Bytes of a file; 0 for a directory or a link. */
    size: number;
}

export interface FastWalkError {
    path: string;
    errno: number;
}

export interface FastWalkResult {
    engine: "native" | "js";
    entries: FastWalkEntry[];
    /** Directories that could not be read. */
    errors: FastWalkError[];
}

const { log } = logger.scoped("fast-walk");

// macOS 26 SDK values (`sys/attr.h`, `fcntl.h`, `sys/vnode.h`), checked against the headers on 2026-10-12.
const ATTR_BIT_MAP_COUNT = 5;
const ATTR_CMN_NAME = 0x1;
const ATTR_CMN_OBJTYPE = 0x8;
const ATTR_CMN_MODTIME = 0x400;
const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_FILE_DATALENGTH = 0x200;
const FSOPT_NOFOLLOW = 0x1;
const FSOPT_PACK_INVAL_ATTRS = 0x8;
const VREG = 1;
const VDIR = 2;
const VLNK = 5;
const TWO_TO_32 = 4294967296;
const BULK_BUFFER_BYTES = 256 * 1024;
/** Directories read between two yields to the event loop, so a resident server keeps answering during a walk. */
const DIRECTORIES_PER_YIELD = 256;

/** A name to match as bytes: a whole name (`names`) or an ending (`endsWith`). */
interface BytePattern {
    suffix: boolean;
    bytes: Uint8Array;
}

function bytePatterns(options: { names: string[]; endsWith: string[] }): BytePattern[] {
    const encoder = new TextEncoder();
    return [
        ...options.names.map((name) => ({ suffix: false, bytes: encoder.encode(name) })),
        ...options.endsWith.map((ending) => ({ suffix: true, bytes: encoder.encode(ending) })),
    ];
}

function nameMatches(buffer: Uint8Array, start: number, length: number, patterns: BytePattern[]): boolean {
    if (patterns.length === 0) {
        return true;
    }

    for (const pattern of patterns) {
        const bytes = pattern.bytes;

        if (pattern.suffix ? length < bytes.length : length !== bytes.length) {
            continue;
        }

        const from = start + length - bytes.length;
        let same = true;

        for (let i = 0; i < bytes.length && same; i++) {
            same = buffer[from + i] === bytes[i];
        }

        if (same) {
            return true;
        }
    }

    return false;
}

/** The calls the native walker makes: an interface, so a test can refuse one folder the way an SMB share does. */
export interface BulkReadCalls {
    open(path: Buffer, flags: number): number;
    getattrlistbulk(fd: number, attributes: Uint8Array, buffer: Uint8Array, size: number, options: number): number;
    close(fd: number): void;
    /** The calling thread's errno, read right after the call that failed. */
    errno(): number;
}

export function bulkReadCalls(calls: LibSystem): BulkReadCalls {
    return {
        open: (path, flags) => calls.open(path, flags),
        getattrlistbulk: (fd, attributes, buffer, size, options) =>
            calls.getattrlistbulk(fd, attributes, buffer, size, options),
        close: (fd) => {
            calls.close(fd);
        },
        errno: () => errnoNow(calls),
    };
}

/**
 * The macOS walker: one `getattrlistbulk` call returns the name, type, mtime and size of many entries of a directory,
 * so a directory costs one `open`, a few bulk reads and one `close`, and no file is stat'ed on its own. The calls go
 * straight to `libSystem` through `bun:ffi` and the entries are read in place, decoding a name only for a directory
 * to enter or an entry to return. The arrays go to every call as arrays (see `defineSystemLibrary` for why).
 */
export async function walkNative(
    calls: BulkReadCalls,
    options: Required<Omit<FastWalkOptions, "engine">>
): Promise<FastWalkResult> {
    const entries: FastWalkEntry[] = [];
    const errors: FastWalkError[] = [];
    const patterns = bytePatterns(options);
    const decoder = new TextDecoder();
    const attributes = new Uint8Array(24);
    const attributeView = new DataView(attributes.buffer);
    attributeView.setUint16(0, ATTR_BIT_MAP_COUNT, true);
    attributeView.setUint32(4, ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE | ATTR_CMN_MODTIME, true);
    attributeView.setUint32(16, ATTR_FILE_DATALENGTH, true);
    const buffer = new Uint8Array(BULK_BUFFER_BYTES);
    const words = new Uint32Array(buffer.buffer);
    const signedWords = new Int32Array(buffer.buffer);
    const stack = options.roots.map((root) => ({ directory: root, depth: 0 }));
    let directoriesRead = 0;

    while (stack.length > 0) {
        const next = stack.pop();

        if (!next) {
            break;
        }

        if (++directoriesRead % DIRECTORIES_PER_YIELD === 0) {
            await Bun.sleep(0);
        }

        const fd = calls.open(cPath(next.directory), O_DIRECTORY | O_NONBLOCK | O_CLOEXEC);

        if (fd < 0) {
            errors.push({ path: next.directory, errno: calls.errno() });
            continue;
        }

        let listedAny = false;
        let unsupported = false;

        for (;;) {
            const count = calls.getattrlistbulk(
                fd,
                attributes,
                buffer,
                buffer.length,
                FSOPT_PACK_INVAL_ATTRS | FSOPT_NOFOLLOW
            );

            if (count < 0) {
                const errno = calls.errno();
                // A filesystem without bulk reads (SMB, FUSE and the like) refuses it with ENOTSUP before it returns
                // anything; that folder is walked the portable way instead.
                unsupported = errno === constants.errno.ENOTSUP && !listedAny;

                if (!unsupported) {
                    errors.push({ path: next.directory, errno });
                }

                break;
            }

            if (count === 0) {
                break;
            }

            listedAny = true;

            // Entries are packed in attribute bit order and 4-byte aligned: 0 length | 4 returned attributes |
            // 24 name reference (offset, length with NUL) | 32 object type | 36 mtime (s, ns) | 52 data length.
            // A 64-bit field is read as two 32-bit words, so no BigInt is made per entry.
            let offset = 0;

            for (let i = 0; i < count; i++) {
                const at = offset >> 2;
                const nameStart = offset + 24 + signedWords[at + 6];
                const nameLength = words[at + 7] - 1;
                const type = words[at + 8];
                offset += words[at];
                const descend = type === VDIR && next.depth + 1 <= options.maxDepth;
                const wanted =
                    (type === VDIR && options.includeDirectories) ||
                    type === VLNK ||
                    (type === VREG && nameMatches(buffer, nameStart, nameLength, patterns));

                if (!descend && !wanted) {
                    continue;
                }

                const path = `${next.directory}/${decoder.decode(buffer.subarray(nameStart, nameStart + nameLength))}`;

                if (wanted) {
                    entries.push({
                        kind: type === VDIR ? "directory" : type === VLNK ? "link" : "file",
                        path,
                        mtimeMs: (signedWords[at + 10] * TWO_TO_32 + words[at + 9]) * 1000 + words[at + 11] / 1e6,
                        size: type === VREG ? signedWords[at + 14] * TWO_TO_32 + words[at + 13] : 0,
                    });
                }

                if (descend) {
                    stack.push({ directory: path, depth: next.depth + 1 });
                }
            }
        }

        calls.close(fd);

        if (unsupported) {
            log.debug(
                { directory: next.directory },
                "fast-walk: no getattrlistbulk on this filesystem; walking it with readdir"
            );
            const portable = await walkJs({
                ...options,
                roots: [next.directory],
                maxDepth: options.maxDepth - next.depth,
            });
            entries.push(...portable.entries);
            errors.push(...portable.errors);
        }
    }

    return { engine: "native", entries, errors };
}

function nameMatcher(options: { names: string[]; endsWith: string[] }): (name: string) => boolean {
    if (options.names.length === 0 && options.endsWith.length === 0) {
        return () => true;
    }

    const exact = new Set(options.names);
    return (name) => exact.has(name) || options.endsWith.some((ending) => name.endsWith(ending));
}

function errnoOf(err: unknown): number {
    return err instanceof Error && "errno" in err && typeof err.errno === "number" ? Math.abs(err.errno) : 0;
}

/** The portable walker: `readdir` with types, and an `lstat` only for what is returned. */
async function walkJs(options: Required<Omit<FastWalkOptions, "engine">>): Promise<FastWalkResult> {
    const entries: FastWalkEntry[] = [];
    const errors: FastWalkError[] = [];
    const matches = nameMatcher(options);
    const stack = options.roots.map((root) => ({ directory: root, depth: 0 }));

    while (stack.length > 0) {
        const next = stack.pop();

        if (!next) {
            break;
        }

        let listed: Dirent[];

        try {
            listed = await readdir(next.directory, { withFileTypes: true });
        } catch (err) {
            errors.push({ path: next.directory, errno: errnoOf(err) });
            continue;
        }

        for (const dirent of listed) {
            const path = join(next.directory, dirent.name);
            const wanted = dirent.isDirectory()
                ? options.includeDirectories
                : dirent.isFile()
                  ? matches(dirent.name)
                  : dirent.isSymbolicLink();

            if (wanted) {
                try {
                    const status = await lstat(path);
                    entries.push({
                        kind: dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "link",
                        path,
                        mtimeMs: status.mtimeMs,
                        size: dirent.isFile() ? status.size : 0,
                    });
                } catch (err) {
                    log.debug({ err, path }, "fast-walk: an entry vanished during the walk");
                }
            }

            if (dirent.isDirectory() && next.depth + 1 <= options.maxDepth) {
                stack.push({ directory: path, depth: next.depth + 1 });
            }
        }
    }

    return { engine: "js", entries, errors };
}

/**
 * Every file under `roots` whose name matches, with its mtime and size, from one walk. On macOS each directory is
 * read with `getattrlistbulk` through `bun:ffi` (no C, no build step), so no file is stat'ed on its own: 2 to 3 times
 * less CPU than `readdir` plus `stat` on the session trees (`scripts/benchmarks/fs/walk-primitives.ts`). Elsewhere,
 * or when `libSystem` does not load, a JS walk returns the same entries; so does a folder on a filesystem that
 * refuses `getattrlistbulk` (ENOTSUP), for that folder and everything under it. Order is not defined. A directory that
 * cannot be read is listed in `errors` and the walk goes on. Measurements and the rules it follows:
 * `src/utils/bun/compiler/README.md`.
 */
export async function fastWalk(options: FastWalkOptions): Promise<FastWalkResult> {
    const resolved = {
        roots: options.roots,
        maxDepth: options.maxDepth ?? Number.POSITIVE_INFINITY,
        names: options.names ?? [],
        endsWith: options.endsWith ?? [],
        includeDirectories: options.includeDirectories ?? false,
    };
    const calls = options.engine === "js" ? null : libSystem();

    if (calls) {
        return walkNative(bulkReadCalls(calls), resolved);
    }

    if (options.engine === "native") {
        throw new Error("fast-walk: the native walker is not available on this machine");
    }

    return walkJs(resolved);
}
