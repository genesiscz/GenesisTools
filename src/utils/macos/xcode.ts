import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

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
        return `Run \`${toolCommand("macos permissions build")}\`.`;
    }

    return `GenesisTools.app needs the full Xcode (SwiftUI macros are not in the Command Line Tools): install Xcode, select it with \`sudo xcode-select -s <path to your Xcode.app>\` (for example /Applications/Xcode.app), then \`${toolCommand("macos permissions build")}\`.`;
}

/**
 * The SDK an app build uses. Full Xcode uses its own (`sdkRoot` unset). With the Command Line Tools, the newest
 * installed SDK whose SwiftUI still declares `@State` as a plain property wrapper: from the macOS 27 SDK on it is a
 * macro, and its plugin (`SwiftUIMacros`) ships only with Xcode, while the 26.5 SDK the same tools carry builds the
 * whole app (#564). `unsupported` when no SDK passes the probe, or there is no toolchain at all.
 */
export type AppBuildSdk =
    | { kind: "xcode" }
    | { kind: "command-line-tools"; sdkRoot: string }
    | { kind: "unsupported"; toolchain: XcodeToolchain };

export interface ResolveAppBuildSdkOptions {
    toolchain?: XcodeToolchain;
    /** Versioned SDKs of a Command Line Tools folder, newest first (injected for tests). */
    listSdks?: (developerDir: string) => string[];
    /** Whether `@State` type-checks against this SDK without the macro plugin (injected for tests). */
    probe?: (sdkRoot: string) => boolean;
}

let cachedSdk: AppBuildSdk | undefined;

export function resolveAppBuildSdk(options?: ResolveAppBuildSdkOptions): AppBuildSdk {
    const injected =
        options?.listSdks !== undefined || options?.probe !== undefined || options?.toolchain !== undefined;

    if (cachedSdk !== undefined && !injected) {
        return cachedSdk;
    }

    const toolchain = options?.toolchain ?? detectXcodeToolchain();
    let result: AppBuildSdk;

    if (toolchain.kind === "xcode") {
        result = { kind: "xcode" };
    } else if (toolchain.kind === "command-line-tools") {
        const sdks = (options?.listSdks ?? listCommandLineToolsSdks)(toolchain.developerDir);
        const probe = options?.probe ?? swiftUiStateIsPlainWrapper;
        const sdkRoot = sdks.find((sdk) => probe(sdk));
        result = sdkRoot ? { kind: "command-line-tools", sdkRoot } : { kind: "unsupported", toolchain };
    } else {
        result = { kind: "unsupported", toolchain };
    }

    if (!injected) {
        cachedSdk = result;
    }

    return result;
}

/** `MacOSX26.5.sdk` → [26, 5]; the unversioned `MacOSX.sdk` and the `MacOSX26.sdk` symlinks are skipped. */
export function sdkVersion(name: string): [number, number] | undefined {
    const match = /^MacOSX(\d+)\.(\d+)\.sdk$/.exec(name);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** The versioned macOS SDKs in `<developerDir>/SDKs`, newest first. */
export function listCommandLineToolsSdks(developerDir: string): string[] {
    const dir = join(developerDir, "SDKs");

    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .map((name) => ({ name, version: sdkVersion(name) }))
        .filter((entry): entry is { name: string; version: [number, number] } => entry.version !== undefined)
        .filter((entry) => !lstatSync(join(dir, entry.name)).isSymbolicLink())
        .sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1])
        .map((entry) => join(dir, entry.name));
}

const STATE_PROBE = [
    "import SwiftUI",
    "struct GenesisSdkProbe: View {",
    "    @State private var on = false",
    '    var body: some View { Text(on ? "a" : "b").onTapGesture { on.toggle() } }',
    "}",
    "",
].join("\n");

/**
 * Type-checks one `@State` view against `sdkRoot` (about 2 s). The answer is kept per SDK in
 * `~/.genesis-tools/app/sdk-probe.json`, keyed by the SDK's `SDKSettings.json` time, so a Command Line Tools update
 * probes again and nothing else does.
 */
export function swiftUiStateIsPlainWrapper(sdkRoot: string): boolean {
    const settings = join(sdkRoot, "SDKSettings.json");
    const stamp = existsSync(settings) ? String(statSync(settings).mtimeMs) : "none";
    const cacheFile = genesisToolsDir("app", "sdk-probe.json");
    let cache: Record<string, { stamp: string; ok: boolean }> = {};

    try {
        cache = existsSync(cacheFile) ? SafeJSON.parse(readFileSync(cacheFile, "utf8"), { strict: true }) : {};
    } catch (error) {
        logger.debug({ error, cacheFile }, "sdk probe cache unreadable; probing again");
    }

    const hit = cache[sdkRoot];

    if (hit?.stamp === stamp) {
        return hit.ok;
    }

    const probeFile = genesisToolsDir("app", "sdk-probe.swift");
    mkdirSync(dirname(probeFile), { recursive: true });
    writeFileSync(probeFile, STATE_PROBE);
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const proc = Bun.spawnSync(
        ["xcrun", "swiftc", "-typecheck", "-sdk", sdkRoot, "-target", `${arch}-apple-macos14.0`, probeFile],
        { stdout: "pipe", stderr: "pipe" }
    );
    const ok = proc.exitCode === 0;
    logger.debug({ sdkRoot, ok }, "sdk probe: @State without the SwiftUI macro plugin");
    cache[sdkRoot] = { stamp, ok };
    writeFileSync(cacheFile, SafeJSON.stringify(cache, null, 2));
    return ok;
}
