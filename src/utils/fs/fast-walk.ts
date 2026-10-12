import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { type Dirent, existsSync, readFileSync, renameSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

export interface FastWalkOptions {
    /** Absolute roots, already resolved (a symbolic link given as a root is listed, not followed below). */
    roots: string[];
    /** The root is depth 0; a directory deeper than this is not entered. Unset: no limit. */
    maxDepth?: number;
    /** Files to return: exact names, or `*suffix` patterns (`*.jsonl`). Unset: every file. */
    names?: string[];
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
const SOURCE = join(import.meta.dir, "native", "fastwalk.c");

interface NativeWalker {
    walk(input: { roots: string[]; maxDepth: number; names: string[]; includeDirectories: boolean }): string;
}

let native: NativeWalker | null | undefined;

/**
 * The compiled walker, built on first use with `clang` into `native/` beside the source and named by the source's
 * hash, so an edited source never loads a stale library and parallel processes never share a half-written one.
 * Null off macOS, or when the build fails (the JS walker answers then, with the same result).
 */
function nativeWalker(): NativeWalker | null {
    if (native !== undefined) {
        return native;
    }

    native = null;

    if (process.platform !== "darwin" || !existsSync(SOURCE)) {
        return native;
    }

    try {
        const hash = Bun.hash(readFileSync(SOURCE)).toString(16);
        const library = join(import.meta.dir, "native", `libfastwalk-${hash}.dylib`);

        if (!existsSync(library)) {
            const building = `${library}.${process.pid}.tmp`;
            const built = Bun.spawnSync(["clang", "-O2", "-dynamiclib", "-o", building, SOURCE], { stderr: "pipe" });

            if (built.exitCode !== 0) {
                log.warn(
                    { stderr: built.stderr.toString().slice(0, 2000) },
                    "fast-walk: native build failed; using JS"
                );
                return native;
            }

            renameSync(building, library);
            log.debug({ library }, "fast-walk: built the native walker");
        }

        const { symbols } = dlopen(library, {
            fw_walk: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
            fw_free: { args: [FFIType.ptr], returns: FFIType.void },
        });
        native = {
            walk({ roots, maxDepth, names, includeDirectories }) {
                const length = new BigUint64Array(1);
                const result = symbols.fw_walk(
                    Buffer.from(`${roots.join("\n")}\0`),
                    maxDepth,
                    Buffer.from(`${names.join("\n")}\0`),
                    includeDirectories ? 1 : 0,
                    ptr(length)
                );

                if (!result) {
                    throw new Error("fast-walk: the native walker returned no buffer");
                }

                try {
                    return new TextDecoder().decode(toArrayBuffer(result, 0, Number(length[0])));
                } finally {
                    symbols.fw_free(result);
                }
            },
        };
    } catch (err) {
        log.warn({ err }, "fast-walk: native walker unavailable; using JS");
        native = null;
    }

    return native;
}

function parseNative(text: string): Pick<FastWalkResult, "entries" | "errors"> {
    const entries: FastWalkEntry[] = [];
    const errors: FastWalkError[] = [];

    for (const line of text.split("\n")) {
        if (!line) {
            continue;
        }

        const first = line.indexOf("\t");
        const second = line.indexOf("\t", first + 1);
        const third = line.indexOf("\t", second + 1);
        const kind = line.slice(0, first);
        const mtimeMs = Number(line.slice(first + 1, second));
        const size = Number(line.slice(second + 1, third));
        const path = line.slice(third + 1);

        if (kind === "e") {
            errors.push({ path, errno: size });
            continue;
        }

        entries.push({ kind: kind === "f" ? "file" : kind === "d" ? "directory" : "link", path, mtimeMs, size });
    }

    return { entries, errors };
}

function nameMatcher(names: string[]): (name: string) => boolean {
    if (names.length === 0) {
        return () => true;
    }

    const exact = new Set(names.filter((name) => !name.startsWith("*")));
    const suffixes = names.filter((name) => name.startsWith("*")).map((name) => name.slice(1));
    return (name) => exact.has(name) || suffixes.some((suffix) => name.endsWith(suffix));
}

function errnoOf(err: unknown): number {
    return err instanceof Error && "errno" in err && typeof err.errno === "number" ? Math.abs(err.errno) : 0;
}

/** The portable walker: `readdir` with types, and an `lstat` only for what is returned. */
async function walkJs(options: Required<Omit<FastWalkOptions, "engine">>): Promise<FastWalkResult> {
    const entries: FastWalkEntry[] = [];
    const errors: FastWalkError[] = [];
    const matches = nameMatcher(options.names);
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
 * Every file under `roots` whose name matches, with its mtime and size, from one walk. On macOS the walk is one
 * native call that reads each directory with `getattrlistbulk` (name, type, mtime and size of many entries per
 * syscall), so no file is stat'ed on its own; elsewhere, or when the native build fails, a JS walk returns the
 * same entries. Order is not defined. A directory that cannot be read is listed in `errors` and the walk goes on.
 */
export async function fastWalk(options: FastWalkOptions): Promise<FastWalkResult> {
    const resolved = {
        roots: options.roots,
        maxDepth: options.maxDepth ?? Number.POSITIVE_INFINITY,
        names: options.names ?? [],
        includeDirectories: options.includeDirectories ?? false,
    };
    const walker = options.engine === "js" ? null : nativeWalker();

    if (walker) {
        const text = walker.walk({
            roots: resolved.roots,
            maxDepth: Number.isFinite(resolved.maxDepth) ? resolved.maxDepth : -1,
            names: resolved.names,
            includeDirectories: resolved.includeDirectories,
        });
        return { engine: "native", ...parseNative(text) };
    }

    if (options.engine === "native") {
        throw new Error("fast-walk: the native walker is not available on this machine");
    }

    return walkJs(resolved);
}
