import { dlopen, type FFIFunction, type Library } from "bun:ffi";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("bun-compiler");

export interface SystemLibraryOptions<Fns extends Record<string, FFIFunction>> {
    /** An absolute path (`/usr/lib/libSystem.B.dylib`) or a name the dynamic loader resolves. */
    path: string;
    symbols: Fns;
    /** Platforms that have this library; elsewhere the getter answers null. */
    platforms: NodeJS.Platform[];
}

/**
 * A system library called straight through `bun:ffi`, with no C of our own: the getter opens it on first use and
 * answers the same symbols after that, or null on another platform or when it does not load (logged).
 *
 * Hand a typed array to each call, never a pointer taken once with `ptr()`: the engine may move a small typed array
 * during garbage collection, and a cached pointer then reads freed memory. Measured on 2026-10-12: a walk that
 * cached `ptr()` of its 24-byte attribute list found 12,107 of 13,847 files, and 0 on every later walk.
 */
export function defineSystemLibrary<Fns extends Record<string, FFIFunction>>(
    options: SystemLibraryOptions<Fns>
): () => Library<Fns>["symbols"] | null {
    let symbols: Library<Fns>["symbols"] | null | undefined;

    return () => {
        if (symbols !== undefined) {
            return symbols;
        }

        symbols = null;

        if (!options.platforms.includes(process.platform)) {
            return symbols;
        }

        try {
            symbols = dlopen(options.path, options.symbols).symbols;
            log.debug({ path: options.path }, "bun-compiler: opened a system library");
        } catch (err) {
            log.warn({ err, path: options.path }, "bun-compiler: a system library did not load");
        }

        return symbols;
    };
}
