import { logger } from "@genesiscz/utils/logger";

/**
 * Which Swift toolchain `xcode-select -p` points at. The Command Line Tools ship no SwiftUI
 * macro plugin (`SwiftUIMacros`), so a build under them fails with 100+ cascading compiler
 * errors instead of one clear message (#445). `developerDir` is the raw `xcode-select -p` path.
 */
export type XcodeToolchain =
    | { kind: "xcode"; developerDir: string }
    | { kind: "command-line-tools"; developerDir: string }
    | { kind: "none" };

type SpawnSyncResult = { exitCode: number; stdout: string };
type SpawnSync = (cmd: string[]) => SpawnSyncResult;

function defaultSpawnSync(cmd: string[]): SpawnSyncResult {
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { exitCode: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout) };
}

/** Classify a raw `xcode-select -p` path. Exercised through `detectXcodeToolchain`'s tests via its injected spawn. */
function classifyDeveloperDir(developerDir: string): XcodeToolchain {
    const trimmed = developerDir.trim();

    if (!trimmed) {
        return { kind: "none" };
    }

    if (trimmed.endsWith("/CommandLineTools")) {
        return { kind: "command-line-tools", developerDir: trimmed };
    }

    return { kind: "xcode", developerDir: trimmed };
}

let cached: XcodeToolchain | undefined;

export interface DetectXcodeToolchainOptions {
    /** Injected for tests; the real `xcode-select -p` spawn is the default. */
    spawnSync?: SpawnSync;
    /** Bypass the per-process cache (tests only; the real toolchain cannot change mid-process). */
    force?: boolean;
}

/**
 * Detects the active Swift toolchain. Cached per process (`xcode-select -p` cannot change
 * answer mid-run, and `buildApp()` calls this on every build). Never throws: a missing binary,
 * a non-zero exit or a non-darwin host all read as `{ kind: "none" }` so a hint caller always
 * has something safe to fall back to.
 *
 * The platform guard is skipped when `spawnSync` is injected, so the classification logic is
 * exercised on every CI platform even though the real spawn only ever runs on macOS.
 */
export function detectXcodeToolchain(options?: DetectXcodeToolchainOptions): XcodeToolchain {
    if (cached !== undefined && !options?.force) {
        return cached;
    }

    if (!options?.spawnSync && process.platform !== "darwin") {
        cached = { kind: "none" };
        return cached;
    }

    const spawn = options?.spawnSync ?? defaultSpawnSync;

    try {
        const result = spawn(["xcode-select", "-p"]);

        if (result.exitCode !== 0) {
            logger.debug({ exitCode: result.exitCode }, "xcode-select -p exited non-zero");
            cached = { kind: "none" };
            return cached;
        }

        cached = classifyDeveloperDir(result.stdout);
        return cached;
    } catch (error) {
        logger.debug({ error }, "xcode-select -p threw");
        cached = { kind: "none" };
        return cached;
    }
}

/**
 * The hint to show wherever code used to say "run `tools macos permissions build`". With the
 * Command Line Tools only, that build fails with 100+ Swift compiler errors (#445, #446.1), so
 * this points at installing full Xcode instead.
 */
export function genesisAppBuildHint(toolchain: XcodeToolchain = detectXcodeToolchain()): string {
    if (toolchain.kind === "xcode") {
        return "Run `tools macos permissions build`.";
    }

    return "GenesisTools.app needs the full Xcode (SwiftUI macros are not in the Command Line Tools): install Xcode, select it with `sudo xcode-select -s <path to your Xcode.app>` (for example /Applications/Xcode.app), then `tools macos permissions build`.";
}
