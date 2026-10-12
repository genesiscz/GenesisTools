import { cc, dlopen, type FFIFunction, type Library, suffix } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const { log } = logger.scoped("bun-compiler");

export interface CompileOptions {
    /** Absolute path of the C source. */
    source: string;
    /** Other files the build reads, such as local headers: a change in any of them is a new build. */
    dependsOn?: string[];
    /** Compiler flags, part of the build's identity. Default `-O2`. */
    flags?: string[];
    /** Where built libraries are kept. Default `~/.genesis-tools/bun-compiler/libraries`. */
    cacheDir?: string;
}

export interface NativeLibraryOptions<Fns extends Record<string, FFIFunction>> extends CompileOptions {
    symbols: Fns;
    /**
     * `auto` (default): the cached build of this exact source, else a new build with the system C compiler, else
     * TinyCC. `clang` never falls back. `tcc` compiles in memory with Bun's TinyCC and writes nothing.
     */
    compiler?: "auto" | "clang" | "tcc";
}

export interface NativeLibrary<Fns extends Record<string, FFIFunction>> {
    symbols: Library<Fns>["symbols"];
    /** `cache`: a build from an earlier process; `clang`: built by this process; `tcc`: compiled in memory. */
    via: "cache" | "clang" | "tcc";
    /** The library file; absent for TinyCC. */
    path?: string;
}

const DEFAULT_FLAGS = ["-O2"];

/**
 * The file a build of this exact source goes to. Its name carries a hash of the source, every `dependsOn` file, the
 * flags, the platform and the CPU, so an edit to any of them names a new file and an unchanged source finds its
 * earlier build. A source that cannot be read throws.
 */
export function compiledLibraryPath(options: CompileOptions): string {
    const flags = options.flags ?? DEFAULT_FLAGS;
    const hash = new Bun.CryptoHasher("sha256");
    hash.update(`${process.platform}\0${process.arch}\0${flags.join("\0")}\0`);

    for (const file of [options.source, ...(options.dependsOn ?? [])]) {
        hash.update(`${file}\0`);
        hash.update(readFileSync(file));
    }

    const stem = basename(options.source, extname(options.source));
    const directory = options.cacheDir ?? toolDataDir("bun-compiler", "libraries");
    return join(directory, `${stem}-${hash.digest("hex").slice(0, 16)}.${suffix}`);
}

/**
 * Builds the source into a shared library unless a build of this exact source already exists, and answers its path
 * and whether this call built it. A build goes to a temporary name and is renamed into place, so two processes that
 * build at once never load a half-written file. Throws when no C compiler is installed or the build fails.
 */
export function ensureCompiled(options: CompileOptions): { path: string; built: boolean } {
    const path = compiledLibraryPath(options);

    if (existsSync(path)) {
        return { path, built: false };
    }

    const compiler = Bun.which("clang") ?? Bun.which("cc");

    if (!compiler) {
        throw new Error(`bun-compiler: no C compiler (clang or cc) on PATH to build ${options.source}`);
    }

    const started = performance.now();
    const building = `${path}.${process.pid}.tmp`;
    const shared = process.platform === "darwin" ? ["-dynamiclib"] : ["-shared", "-fPIC"];
    mkdirSync(join(path, ".."), { recursive: true });
    const result = Bun.spawnSync(
        [compiler, ...(options.flags ?? DEFAULT_FLAGS), ...shared, "-o", building, options.source],
        { stdout: "pipe", stderr: "pipe" }
    );

    if (result.exitCode !== 0) {
        throw new Error(
            `bun-compiler: ${basename(compiler)} failed on ${options.source}: ${result.stderr.toString().slice(0, 2000)}`
        );
    }

    renameSync(building, path);
    log.debug(
        { source: options.source, path, ms: Math.round(performance.now() - started) },
        "bun-compiler: built a library"
    );
    return { path, built: true };
}

function loadNativeLibrary<Fns extends Record<string, FFIFunction>>(
    options: NativeLibraryOptions<Fns>
): NativeLibrary<Fns> {
    const compiler = options.compiler ?? "auto";

    if (compiler !== "tcc") {
        try {
            const { path, built } = ensureCompiled(options);
            return { symbols: dlopen(path, options.symbols).symbols, via: built ? "clang" : "cache", path };
        } catch (err) {
            if (compiler === "clang") {
                throw err;
            }

            log.warn({ err, source: options.source }, "bun-compiler: no cached or new build; compiling with TinyCC");
        }
    }

    const started = performance.now();
    const symbols = cc({ source: options.source, symbols: options.symbols, flags: options.flags }).symbols;
    log.debug(
        { source: options.source, ms: Math.round(performance.now() - started) },
        "bun-compiler: compiled with TinyCC in memory"
    );
    return { symbols, via: "tcc" };
}

/**
 * A C source loaded through `bun:ffi`, compiled once: the getter loads it on first use and answers the same library
 * after that. With a C compiler installed, a source is built once per version and every later process opens that
 * build (about a millisecond). Without one, Bun's TinyCC compiles it in memory once per process (33 to 64 ms for
 * the 200-line walker in `scripts/benchmarks/fs/fastwalk.c`); Bun's `cc` cannot write its output to a file, so a
 * TinyCC build is never shared between processes. A source edited while a process runs is picked up by the next
 * process, not this one.
 *
 * Which loader to use, what was measured (clang, TinyCC and pure FFI side by side), and how to measure: `README.md`
 * in this folder.
 */
export function defineNativeLibrary<Fns extends Record<string, FFIFunction>>(
    options: NativeLibraryOptions<Fns>
): () => NativeLibrary<Fns> {
    let library: NativeLibrary<Fns> | undefined;

    return () => {
        library ??= loadNativeLibrary(options);
        return library;
    };
}
