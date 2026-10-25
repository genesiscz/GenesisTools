import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isInteractive } from "@genesiscz/utils/cli";
import { PRESETS } from "@genesiscz/utils/compress/presets";
import { applyFolderRetention, planFolderRetention } from "@genesiscz/utils/compress/retention";
import { env } from "@genesiscz/utils/env";
import { createGit } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    GENESIS_APP_BUNDLE_ID,
    GENESIS_APP_NAME,
    genesisAppBundlePath,
    genesisAppDir,
    genesisAppInstallMarkerPath,
    genesisAppLauncherPath,
} from "@genesiscz/utils/macos/genesis-app";
import { readStagingMarker } from "@genesiscz/utils/macos/native-inbox";
import { type AppBuildSdk, genesisAppBuildHint, resolveAppBuildSdk } from "@genesiscz/utils/macos/xcode";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { clearPidFile, writePidFile } from "@genesiscz/utils/process/pidfile";
import { executableInode } from "@genesiscz/utils/process/process-files";
import { listProcesses, type ProcessEntry } from "@genesiscz/utils/process/processes";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import * as p from "@genesiscz/utils/prompts/p";
import { withFileLock } from "@genesiscz/utils/storage";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import {
    type ClickyLibraryPin,
    ClickyLibraryUnavailableError,
    ensureClickyLibrary,
    unpackClickyLibrary,
} from "../clicky-library";
import {
    ALL_PART_IDS,
    APP_PARTS,
    bundleStepsFor,
    installedParts,
    isFullBuild,
    type PartsChoice,
    partForFace,
    partsEnvValue,
    partsForBuild,
    scratchName,
} from "./parts";
import { captureRelaunch, linkRelayAmong, type RelaunchCapture, runRelaunch } from "./relaunch";
import { createSwiftProgressReporter } from "./swift-progress";

export const APP_SOURCE_DIR = resolve(import.meta.dirname, "../../GenesisTools");
/** GenesisKit's markdown renderer (markdown-it, highlight.js, mermaid); the viewer reads Contents/Resources/webview first. */
const MARKDOWN_WEBVIEW_SOURCE = resolve(APP_SOURCE_DIR, "../GenesisKit/Sources/GenesisKit/Markdown/Resources/webview");
/** The app build's own SwiftPM scratch folder, apart from `.build/debug` (tests, benches) so the two never rebuild each other. */
const APP_MODULE_CACHE_PATH = join(APP_SOURCE_DIR, ".build", "module-cache");

/** One SwiftPM scratch folder per parts set (parts.ts `scratchName`): `.build/opt` for every part. */
function appScratchPath(parts: readonly string[]): string {
    return join(APP_SOURCE_DIR, ".build", scratchName(parts));
}
export const APP_TOOLS_PATH = resolve(APP_SOURCE_DIR, "../../../tools");
/** The shared SwiftUI package the app links (src/macos/GenesisKit), so an edit there marks the build stale too. */
const SOURCE_ROOTS = [
    "Package.swift",
    "Info.plist",
    "Sources",
    "scripts/AppIcon.icns",
    "web",
    "ClickyLibrary.json",
    "../GenesisKit/Package.swift",
    "../GenesisKit/Sources",
];
/**
 * What the host alone compiles: its own folders and GenesisKitBase (`GENESIS_KIT_BASE_ONLY`). A permissions-only
 * install must not count as stale when a part it does not link changes, or every routine update rebuilt it.
 */
const HOST_SOURCE_ROOTS = [
    "Package.swift",
    "Info.plist",
    "Sources/Host",
    "Sources/GenesisTools",
    "scripts/AppIcon.icns",
    "../GenesisKit/Package.swift",
    "../GenesisKit/Sources/GenesisKitBase",
];

/**
 * The inputs of a build with these parts. Every part links the whole GenesisKit; `web` and the Clicky pin are
 * bundle inputs. A full build keeps `SOURCE_ROOTS` exactly, so its hash matches the manifests written before this.
 */
export function sourceRootsFor(parts: readonly string[]): readonly string[] {
    if (isFullBuild(parts)) {
        return SOURCE_ROOTS;
    }

    if (parts.length === 0) {
        return HOST_SOURCE_ROOTS;
    }

    const partFolders = APP_PARTS.filter((part) => parts.includes(part.id)).map(
        (part) => `Sources/Parts/${part.id.charAt(0).toUpperCase()}${part.id.slice(1)}`
    );
    const bundleSteps = bundleStepsFor(parts);
    const web = bundleSteps.has("diff-viewer") ? ["web"] : [];
    const clicky = bundleSteps.has("clicky-library") ? ["ClickyLibrary.json"] : [];

    return [
        ...HOST_SOURCE_ROOTS.filter((root) => root !== "../GenesisKit/Sources/GenesisKitBase"),
        ...partFolders,
        ...web,
        ...clicky,
        "../GenesisKit/Sources",
    ];
}

/** Browser half of the diff renderer (PierreWebDiffRenderer.swift): bundled into Contents/Resources/diff-viewer. */
const DIFF_VIEWER_SOURCE = "web/diff-viewer";
/** Which GitHub release asset holds Clicky's sound library (10 MB, kept out of the repository; clicky-library.ts). */
const CLICKY_LIBRARY_PIN = "ClickyLibrary.json";
const ICON_SOURCE = "scripts/AppIcon.icns";
const ICON_GENERATOR = "scripts/build-icon.swift";
/** Info.plist CFBundleIconFile value; the file lands at Contents/Resources/AppIcon.icns. */
const ICON_NAME = "AppIcon";
/** A cold `swift build` of the launcher takes about a minute; leave room for a slower machine. */
const BUILD_LOCK_TIMEOUT_MS = 240_000;
const PLIST_VERSION_MARKER = "<string>0.0.0</string>";
const PLIST_BUILD_MARKER = "<key>CFBundleVersion</key>\n\t<string>1</string>";
export const LSREGISTER =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** Which checkout and commit an install was built from, so "what is running?" is one `bun run app:status`. */
export interface AppSourceInfo {
    /** The checkout or worktree the Swift sources were read from. */
    sourceRoot?: string;
    sourceBranch?: string;
    sourceCommit?: string;
    /** True when the Swift sources had uncommitted changes at build time, so the commit alone does not name the code. */
    sourceDirty?: boolean;
}

export interface AppManifest extends AppSourceInfo {
    builtAt: string;
    sourceHash: string;
    sourceToolsPath?: string;
    signedWith: string;
    /** The SHA-1 of the certificate that signed, when the name is shared by several: the next build tries it first. */
    signedWithHash?: string;
    teamId?: string;
    /** The optional parts this build links (parts.ts). Absent in builds from before parts existed: every part. */
    parts?: string[];
}

export interface SignatureInfo {
    /** "adhoc" or the certificate authority line */
    authority: string;
    teamId?: string;
    identifier?: string;
    adhoc: boolean;
}

export interface AppStatus {
    bundlePath: string;
    launcherPath: string;
    built: boolean;
    manifest?: AppManifest;
    signature?: SignatureInfo;
    /** sources changed since the last build */
    stale: boolean;
    /** The optional parts the installed build links (parts.ts `installedParts`); empty when nothing is installed. */
    parts: string[];
    /** ad-hoc signatures change on every build, so TCC forgets the grants each time */
    identityStable: boolean;
}

/**
 * `hashes` holds the SHA-1 of every keychain identity with that name, in `find-identity` order. Two certificates with
 * one name (a renewed Apple Development certificate next to the old one) make `codesign --sign <name>` fail with
 * "ambiguous", after the whole build; signing by hash never is.
 */
export type CodesignIdentity =
    | { kind: "developer-id" | "apple-development" | "custom"; name: string; hashes?: string[] }
    | { kind: "adhoc" };

/** Every `N) <SHA-1> "<name>"` row of `security find-identity -v -p codesigning`, in its order. */
export function listCodesignIdentities(findIdentityOutput: string): { hash: string; name: string }[] {
    return [...findIdentityOutput.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((match) => ({
        hash: match[1],
        name: match[2],
    }));
}

function withHashes(
    kind: "developer-id" | "apple-development" | "custom",
    name: string,
    identities: { hash: string; name: string }[]
): CodesignIdentity {
    const hashes = identities.filter((identity) => identity.name === name).map((identity) => identity.hash);
    return hashes.length > 1 ? { kind, name, hashes } : { kind, name };
}

/** Emits complete lines from streamed chunks, including a final unterminated line. */
function buildLineReader(onLine: (line: string) => void) {
    const decoder = new TextDecoder();
    let pending = "";
    return {
        write(chunk: Uint8Array) {
            pending += decoder.decode(chunk, { stream: true });
            const lines = pending.split(/\r\n|\n|\r/);
            pending = lines.pop() ?? "";
            for (const line of lines) {
                onLine(line);
            }
        },
        finish() {
            pending += decoder.decode();
            if (pending) {
                onLine(pending);
            }
        },
    };
}

const STREAMING_BUILD_TIMEOUT_MS = 15 * 60_000;

/** Streams build output under a deadline; timeout terminates its process group and releases the caller's lock. */
export async function runStreaming({
    cmd,
    cwd,
    environment,
    onLine,
    timeoutMs = STREAMING_BUILD_TIMEOUT_MS,
}: {
    cmd: string[];
    cwd?: string;
    /** The whole child environment; default: this process's. */
    environment?: Record<string, string | undefined>;
    onLine: (line: string) => void;
    timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
    logger.debug({ cmd, cwd, timeoutMs }, "permissions app: spawn (streaming)");
    const stdout = buildLineReader(onLine);
    const stderr = buildLineReader(onLine);
    const result = await boundedCommand({
        command: cmd,
        cwd,
        environment,
        timeoutMs,
        maxBufferBytes: 64 * 1024 * 1024,
        onStdout: stdout.write,
        onStderr: stderr.write,
    });
    stdout.finish();
    stderr.finish();
    if (result.error) {
        throw new Error(
            result.error.code === "ETIMEDOUT"
                ? `App build command timed out after ${timeoutMs} ms and was terminated. Check the build log and Swift toolchain, then retry.`
                : `App build command failed: ${result.error.message}`,
            { cause: result.error }
        );
    }

    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function run(
    cmd: string[],
    cwd?: string,
    extraEnv?: Record<string, string>
): { code: number; stdout: string; stderr: string } {
    logger.debug({ cmd, cwd }, "permissions app: spawn");
    const proc = Bun.spawnSync(cmd, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        ...(extraEnv ? { env: { ...env.getProcessEnv(), ...extraEnv } } : {}),
    });
    return {
        code: proc.exitCode,
        stdout: new TextDecoder().decode(proc.stdout),
        stderr: new TextDecoder().decode(proc.stderr),
    };
}

/**
 * The checkout, branch and commit the build reads, through the shared git readers. Dirty means an
 * uncommitted change under any build input (`SOURCE_ROOTS`, the GenesisKit package included), the
 * same set `sourceHash` covers. A failed git read records nothing rather than a clean build.
 */
export async function readSourceInfo(sourceDir = APP_SOURCE_DIR): Promise<AppSourceInfo> {
    const git = createGit({ cwd: sourceDir });

    try {
        const root = await git.getRepoRoot();
        // `all`, not `normal`: a wholly untracked folder must list its files, not collapse into its parent.
        const status = await git.status({ cwd: sourceDir, untracked: "all" });
        const inputs = SOURCE_ROOTS.map((input) => relative(root, resolve(sourceDir, input)));
        const isInput = (path: string | undefined): boolean =>
            path !== undefined && inputs.some((input) => path === input || path.startsWith(`${input}/`));
        // A rename counts from either side: a file moved out of the inputs changes the build too.
        const dirty = status.entries.some(
            (entry) => entry.kind !== "ignored" && (isInput(entry.path) || isInput(entry.origPath))
        );
        const head = status.branch?.head;

        return {
            sourceRoot: root,
            sourceBranch: !head || head === "(detached)" ? "(detached)" : head,
            sourceCommit: status.branch?.oid || (await git.getSha("HEAD")),
            sourceDirty: dirty,
        };
    } catch (error) {
        logger.warn({ sourceDir, error }, "permissions app: build source is not a readable git checkout");
        return {};
    }
}

/** `feat/x @ 1a2b3c4d5e6f+dirty (/path/to/checkout)`, or undefined for a build that predates the record. */
export function describeSource(manifest: AppSourceInfo | undefined): string | undefined {
    if (!manifest?.sourceCommit) {
        return undefined;
    }

    return `${manifest.sourceBranch ?? "?"} @ ${manifest.sourceCommit.slice(0, 12)}${manifest.sourceDirty ? "+dirty" : ""} (${manifest.sourceRoot ?? "?"})`;
}

function sourceFiles(root: string): string[] {
    return readdirSync(root, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
}

/** The paths (not the contents) of every Swift file the build compiles, the app's and GenesisKit's. */
export function swiftFileListHash(sourceDir = APP_SOURCE_DIR): string {
    const hash = createHash("sha256");

    for (const root of SOURCE_ROOTS) {
        const full = join(sourceDir, root);

        if (!existsSync(full) || !statSync(full).isDirectory()) {
            continue;
        }

        for (const file of sourceFiles(full)) {
            if (file.endsWith(".swift")) {
                // Relative, as in `sourceHash`: the same files in another checkout give the same marker.
                hash.update(`${relative(sourceDir, file)}\n`);
            }
        }
    }

    return hash.digest("hex");
}

/** Every file under the source roots, so a new Swift file or a re-rendered icon marks the build stale. */
export function sourceHash(sourceDir = APP_SOURCE_DIR, parts: readonly string[] = ALL_PART_IDS): string {
    const hash = createHash("sha256");

    for (const root of sourceRootsFor(parts)) {
        const full = join(sourceDir, root);

        if (!existsSync(full)) {
            continue;
        }

        const files = statSync(full).isDirectory() ? sourceFiles(full) : [full];

        for (const file of files) {
            hash.update(relative(sourceDir, file));
            hash.update(readFileSync(file));
        }
    }

    return hash.digest("hex").slice(0, 16);
}

/**
 * Pick the signing identity: an override first; then the one the installed app carries, while the keychain still
 * has it; else the most durable one present (Developer ID, then Apple Development), else ad-hoc. The grants
 * follow the signing team, so a certificate of another team that lands first in the keychain (one Xcode made for
 * another account, 2026-10-19) must not re-sign the app, and its unused key hung codesign on a keychain prompt.
 */
export function pickCodesignIdentity(
    findIdentityOutput: string,
    override?: string,
    installed?: string
): CodesignIdentity {
    const identities = listCodesignIdentities(findIdentityOutput);

    if (override) {
        return override === "-" ? { kind: "adhoc" } : withHashes("custom", override, identities);
    }

    const names = identities.map((identity) => identity.name);

    if (installed && names.includes(installed)) {
        const kind = installed.startsWith("Developer ID Application:")
            ? "developer-id"
            : installed.startsWith("Apple Development:")
              ? "apple-development"
              : "custom";
        return withHashes(kind, installed, identities);
    }

    const developerId = names.find((n) => n.startsWith("Developer ID Application:"));

    if (developerId) {
        return withHashes("developer-id", developerId, identities);
    }

    const appleDev = names.find((n) => n.startsWith("Apple Development:"));

    if (appleDev) {
        return withHashes("apple-development", appleDev, identities);
    }

    return { kind: "adhoc" };
}

export function parseCodesignInfo(codesignOutput: string): SignatureInfo {
    const authority = codesignOutput.match(/^Authority=(.+)$/m)?.[1];
    const teamId = codesignOutput.match(/^TeamIdentifier=(.+)$/m)?.[1];
    const identifier = codesignOutput.match(/^Identifier=(.+)$/m)?.[1];
    const adhoc = /^Signature=adhoc$/m.test(codesignOutput) || !authority;

    return {
        authority: adhoc ? "adhoc" : authority,
        teamId: teamId && teamId !== "not set" ? teamId : undefined,
        identifier,
        adhoc,
    };
}

export function readManifest(dir = genesisAppDir()): AppManifest | undefined {
    const path = join(dir, "manifest.json");

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const manifest: AppManifest = SafeJSON.parse(readFileSync(path, "utf8"));
        return manifest;
    } catch (error) {
        logger.warn({ error, path }, "permissions app: manifest unreadable");
        return undefined;
    }
}

export function readSignature(bundlePath = genesisAppBundlePath()): SignatureInfo | undefined {
    if (!existsSync(bundlePath)) {
        return undefined;
    }

    const result = run(["codesign", "-dvv", bundlePath]);
    // codesign prints the details on stderr
    return parseCodesignInfo(`${result.stdout}\n${result.stderr}`);
}

/** Remove `.staging-*` directories left by a crashed build. Only call while holding the build lock. */
function sweepAbandonedStaging(dir = genesisAppDir()): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(".staging-")) {
            logger.debug({ staging: entry.name }, "removing abandoned GenesisTools.app staging directory");
            rmSync(join(dir, entry.name), { recursive: true, force: true });
        }
    }
}

export function appStatus(): AppStatus {
    const bundlePath = genesisAppBundlePath();
    const launcherPath = genesisAppLauncherPath();
    const built = existsSync(launcherPath);
    const manifest = built ? readManifest() : undefined;
    const signature = built ? readSignature(bundlePath) : undefined;
    const parts = installedParts(manifest);
    const stale =
        built &&
        manifest !== undefined &&
        (manifest.sourceHash !== sourceHash(APP_SOURCE_DIR, parts) ||
            (manifest.sourceToolsPath !== undefined && manifest.sourceToolsPath !== APP_TOOLS_PATH));

    return {
        bundlePath,
        launcherPath,
        built,
        manifest,
        signature,
        stale,
        parts,
        identityStable: signature !== undefined && !signature.adhoc,
    };
}

export interface BuildResult {
    bundlePath: string;
    identity: CodesignIdentity;
    signature: SignatureInfo;
    manifest: AppManifest;
}

/** Stamp version and build number into the Info.plist template; throws when a marker is missing. */
export function stampInfoPlist(template: string, buildNumber: number): string {
    for (const marker of [PLIST_VERSION_MARKER, PLIST_BUILD_MARKER]) {
        if (!template.includes(marker)) {
            throw new Error(
                `Info.plist template lacks the marker ${SafeJSON.stringify(marker)}; refusing to build a bundle with a stale version.`
            );
        }
    }

    return template
        .replace(PLIST_VERSION_MARKER, "<string>1.0</string>")
        .replace(PLIST_BUILD_MARKER, `<key>CFBundleVersion</key>\n\t<string>${buildNumber}</string>`);
}

export function stampAppToolsPath(template: string, toolsPath: string): string {
    const closing = /<\/dict>\s*<\/plist>\s*$/;

    if (
        !closing.test(template) ||
        template.includes("<key>GenesisToolsSourceToolsPath</key>") ||
        !toolsPath.startsWith("/")
    ) {
        throw new Error("Cannot stamp the native app's tools origin into this Info.plist.");
    }

    const escaped = toolsPath.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return template.replace(
        closing,
        () => `\t<key>GenesisToolsSourceToolsPath</key>\n\t<string>${escaped}</string>\n</dict>\n</plist>\n`
    );
}

/**
 * swift build → assemble bundle → codesign → manifest. Replaces the bundle atomically.
 *
 * Serialized across processes: two concurrent `permissions build` runs share one `.previous`
 * backup, so without the lock the second run could delete the first run's backup and leave a
 * failed swap with nothing to restore. The timeout covers a cold `swift build`. This lock only
 * orders builds; native commands wait on the install marker, which covers the swap alone.
 */
export interface BuildAppOptions {
    onStep?: (message: string) => void;
    /**
     * Live progress of the long `swift build` step, e.g. "swift build step 180 of 430: Compiling HubAgents.swift, 14 s".
     * Without it the build prints nothing between its steps, which looks like a hang on a cold build.
     */
    onProgress?: (message: string) => void;
    /** false leaves the reaped faces (settings, hub, review, widget, Clicky) closed (`--no-relaunch`); default true. */
    relaunch?: boolean;
    /**
     * Which optional parts to build (parts.ts). Default: the parts already installed, the host alone on a fresh
     * install. `add` puts parts on top of those (a face launcher such as `tools hub`); `exactly` replaces them.
     */
    parts?: Omit<PartsChoice, "installed">;
}

export async function buildApp(options?: BuildAppOptions): Promise<BuildResult> {
    mkdirSync(genesisAppDir(), { recursive: true });
    const lockPath = join(genesisAppDir(), "build.lock");
    const requestedAt = Date.now();
    const caller = process.argv.slice(1).join(" ");

    return withFileLock(
        lockPath,
        async () => {
            const acquiredAt = Date.now();
            logger.info({ lockPath, waitedMs: acquiredAt - requestedAt, caller }, "app build lock acquired");
            let ok = false;

            try {
                // Holding the lock means no other build owns a staging directory, so anything left
                // here is debris from a crashed run and is safe to drop.
                sweepAbandonedStaging();
                const result = await buildAppLocked(options);
                ok = true;
                return result;
            } finally {
                logger.info({ lockPath, heldMs: Date.now() - acquiredAt, ok, caller }, "app build lock released");
            }
        },
        BUILD_LOCK_TIMEOUT_MS
    );
}

/**
 * The SDK the build compiles against, or a refusal before `swift build` ever runs. Full Xcode builds as before. With
 * the Command Line Tools, the build uses the newest SDK whose SwiftUI `@State` needs no macro plugin (the 26.5 SDK
 * next to 27.0, #564), passed as `SDKROOT`. Only when no installed SDK passes does it refuse with the Xcode hint,
 * instead of 100+ cascading "plugin for module 'SwiftUIMacros' not found" errors (#445).
 */
export function requireAppBuildSdk(sdk: AppBuildSdk): { sdkRoot?: string } {
    if (sdk.kind === "unsupported") {
        throw new Error(genesisAppBuildHint(sdk.toolchain));
    }

    return sdk.kind === "command-line-tools" ? { sdkRoot: sdk.sdkRoot } : {};
}

/** Wraps a step reporter so each step's duration is kept; `summary()` names them all, slowest first. */
export function timedSteps(report: (message: string) => void, now: () => number = () => performance.now()) {
    const spans: { name: string; ms: number }[] = [];
    let current: { name: string; start: number } | null = null;
    const close = () => {
        if (current) {
            spans.push({ name: current.name, ms: now() - current.start });
            current = null;
        }
    };

    return {
        step(message: string) {
            close();
            current = { name: message, start: now() };
            report(message);
        },
        summary(): string {
            close();
            const total = spans.reduce((sum, span) => sum + span.ms, 0);
            const parts = [...spans]
                .sort((a, b) => b.ms - a.ms)
                .map((span) => `${span.name} ${(span.ms / 1000).toFixed(1)}s`);
            return `build ${(total / 1000).toFixed(1)}s: ${parts.join(", ")}`;
        },
    };
}

async function buildAppLocked(options?: BuildAppOptions): Promise<BuildResult> {
    const timer = timedSteps(options?.onStep ?? (() => {}));
    try {
        return await buildAppSteps(timer.step, options?.relaunch !== false, options);
    } finally {
        const summary = timer.summary();
        logger.info({ summary }, "GenesisTools.app build timings");
        options?.onStep?.(summary);
    }
}

async function buildAppSteps(
    step: (message: string) => void,
    relaunch: boolean,
    options?: BuildAppOptions
): Promise<BuildResult> {
    if (process.platform !== "darwin") {
        throw new Error("GenesisTools.app can only be built on macOS.");
    }

    if (!Bun.which("swift")) {
        throw new Error("swift not found. Install Xcode or the Command Line Tools, then re-run.");
    }

    const { sdkRoot } = requireAppBuildSdk(resolveAppBuildSdk());

    // SwiftPM's debug configuration with `-O`, in its own scratch folder: release mode is never incremental, so one
    // changed line recompiled all 91 files of the app (58.7 s with whole-module optimization, 18.3 s without), while
    // this rebuilds the changed files only (5.1 s). `-O` is what the compile line carries (no `-Onone`), and no source
    // uses `#if DEBUG`. Hub resize bench, interleaved 3+3 runs (2026-10-07): sidebar p50 8.6/8.1/9.1 vs release
    // 8.6/9.5/8.8 ms, split 10.3/10.1/10.1 vs 10.3/10.0/10.2, window 17.0-17.2 vs 16.6-17.4.
    // SwiftPM's cached build manifest kept the old file list of the GenesisKit path dependency: three merges that
    // added Swift files (2026-10-10) failed with "cannot find type" on the first build and passed on the second. A
    // changed list of Swift files rebuilds the manifest once; a build with the same files keeps the cache.
    // The parts already installed, plus what the caller adds (parts.ts). Each set builds in its own scratch folder,
    // and Package.swift links the part targets `GENESIS_APP_PARTS` names. `--manifest-cache local` keeps the
    // evaluated manifest inside that folder, so a manifest read for one set never answers for another.
    const parts = partsForBuild({ installed: installedParts(readManifest()), ...options?.parts });
    const scratchPath = appScratchPath(parts);
    const partsLabel = parts.length > 0 ? `parts ${parts.join(", ")}` : "host only";
    const fileListMarker = join(scratchPath, "genesis-swift-files.sha256");
    const fileList = swiftFileListHash();
    const fileListChanged = !existsSync(fileListMarker) || readFileSync(fileListMarker, "utf8") !== fileList;
    step(
        fileListChanged
            ? `swift build (optimized, ${partsLabel}; Swift files added or removed, fresh build manifest)`
            : `swift build (optimized, ${partsLabel}, incremental)`
    );
    const reportProgress = options?.onProgress ? createSwiftProgressReporter(options.onProgress, 1000) : () => {};
    const build = await runStreaming({
        cmd: [
            "swift",
            "build",
            "-c",
            "debug",
            "-Xswiftc",
            "-O",
            // One module cache for every parts set, outside the scratch folders: the SDK's clang modules are built
            // once, so a first build of another set does not rebuild them (host only: 12.2 s cold without, 8.7 s
            // with, measured 2026-10-18 for .claude/plans/2026-10-17-FastPermissionsBuild.md).
            "-Xswiftc",
            "-module-cache-path",
            "-Xswiftc",
            APP_MODULE_CACHE_PATH,
            "--scratch-path",
            scratchPath,
            // Only the app and what it links: a plain `swift build` compiles every target, unlinked parts included.
            "--product",
            GENESIS_APP_NAME,
            "--manifest-cache",
            "local",
            ...(fileListChanged ? ["--disable-build-manifest-caching"] : []),
            // A host-only build declares no external package (GENESIS_KIT_BASE_ONLY below). Resolving would rewrite
            // the shared Package.resolved without its pins (it deleted the file, 2026-10-18), and the next full build
            // would write it back: never let a host-only build touch it.
            ...(parts.length === 0 ? ["--disable-automatic-resolution"] : []),
        ],
        cwd: APP_SOURCE_DIR,
        // A host-only build also tells ../GenesisKit to declare only its base library (GENESIS_KIT_BASE_ONLY), so
        // SwiftPM resolves none of the markdown packages the host never compiles.
        environment: {
            ...env.getProcessEnv(),
            GENESIS_APP_PARTS: partsEnvValue(parts),
            GENESIS_KIT_BASE_ONLY: parts.length === 0 ? "1" : undefined,
            ...(sdkRoot ? { SDKROOT: sdkRoot } : {}),
        },
        onLine: reportProgress,
    });

    if (build.code !== 0) {
        throw new Error(`swift build failed (exit ${build.code}):\n${build.stderr || build.stdout}`);
    }

    writeFileSync(fileListMarker, fileList);

    const builtBinary = join(scratchPath, "debug", GENESIS_APP_NAME);

    if (!existsSync(builtBinary)) {
        throw new Error(`swift build produced no binary at ${builtBinary}`);
    }

    step("assemble bundle");
    const plist = stampAppToolsPath(
        stampInfoPlist(readFileSync(join(APP_SOURCE_DIR, "Info.plist"), "utf8"), Math.floor(Date.now() / 1000)),
        APP_TOOLS_PATH
    );
    const iconPath = join(APP_SOURCE_DIR, ICON_SOURCE);

    // The .icns is committed, so a normal build just copies it. Regenerate only if it went
    // missing: without it macOS draws the blank generic page in Finder and notifications.
    if (!existsSync(iconPath)) {
        step("render app icon");
        const icon = run(
            ["swift", join(APP_SOURCE_DIR, ICON_GENERATOR)],
            APP_SOURCE_DIR,
            sdkRoot ? { SDKROOT: sdkRoot } : undefined
        );

        if (icon.code !== 0) {
            logger.warn({ stderr: icon.stderr }, "app icon generation failed; bundle will use the generic icon");
        }
    }

    const appDir = genesisAppDir();
    const bundlePath = genesisAppBundlePath();
    const staging = join(appDir, `.staging-${process.pid}`);
    const contents = join(staging, `${GENESIS_APP_NAME}.app`, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });

    try {
        return await stageAndInstall({
            appDir,
            bundlePath,
            staging,
            contents,
            builtBinary,
            plist,
            iconPath,
            step,
            relaunch,
            parts,
        });
    } finally {
        // Every failure between here and the swap (codesign, verify, rename) used to leave a
        // half-built bundle under ~/.genesis-tools/app; one finally covers them all.
        rmSync(staging, { recursive: true, force: true });
    }
}

/**
 * Bundle the @pierre/diffs viewer page. Shiki grammars stay lazy chunks, so the page loads
 * only the languages a diff needs; the app serves the folder through its own URL scheme
 * because ES module chunks do not load from file://.
 */
export async function buildDiffViewer(contents: string, step: (message: string) => void): Promise<void> {
    const source = join(APP_SOURCE_DIR, DIFF_VIEWER_SOURCE);
    const out = join(contents, "Resources", "diff-viewer");
    step("bundle diff viewer");
    mkdirSync(out, { recursive: true });
    const result = await Bun.build({
        entrypoints: [join(source, "main.ts")],
        outdir: out,
        target: "browser",
        format: "esm",
        splitting: true,
        minify: true,
        naming: { entry: "viewer.js", chunk: "chunks/[name]-[hash].js" },
    });

    if (!result.success) {
        throw new Error(`diff viewer bundle failed: ${result.logs.map((log) => String(log)).join("\n")}`);
    }

    await Bun.write(join(out, "index.html"), Bun.file(join(source, "index.html")));
    // The highlight worker (main.ts `createHighlightWorkers`): pierre's self-contained build, as is.
    const worker = Bun.resolveSync("@pierre/diffs/worker/worker-portable.js", source);
    await Bun.write(join(out, "pierre-worker.js"), Bun.file(worker));
    logger.debug({ out, outputs: result.outputs.length, worker }, "diff viewer bundled");
}

/**
 * Clicky's sound library into Contents/Resources/ClickyLibrary: the pinned release asset (downloaded once, then
 * cached), unpacked to verified WAVs. Without the network on a first build the app is built without it, as before,
 * and says so; Clicky's own switches still work.
 */
export async function bundleClickyLibrary({
    contents,
    step,
    pinPath = join(APP_SOURCE_DIR, CLICKY_LIBRARY_PIN),
    ensure = ensureClickyLibrary,
    unpack = unpackClickyLibrary,
    wanted = readStagingMarker,
}: {
    contents: string;
    step: (message: string) => void;
    /** Clicky runs only where its staging switch is on; elsewhere its 10 MB library is never downloaded. */
    wanted?: () => boolean;
    pinPath?: string;
    ensure?: typeof ensureClickyLibrary;
    unpack?: typeof unpackClickyLibrary;
}): Promise<void> {
    if (!wanted()) {
        step(
            "Clicky sound library skipped: Clicky is a staging face that is off on this Mac (bun scripts/native/staging.ts on, then rebuild)"
        );
        return;
    }

    step("bundle Clicky sound library");
    const out = join(contents, "Resources", "ClickyLibrary");
    const pin = SafeJSON.parse(readFileSync(pinPath, "utf8"), { strict: true }) as ClickyLibraryPin;
    let source: string;
    try {
        source = await ensure(pin);
    } catch (error) {
        if (!(error instanceof ClickyLibraryUnavailableError)) {
            throw error;
        }

        rmSync(out, { recursive: true, force: true });
        logger.warn({ error }, "permissions app: Clicky sound library skipped");
        step(`Clicky sound library skipped: ${error.message}`);
        return;
    }

    const actual = await unpack(source, out);
    if (actual.sets !== pin.sets || actual.samples !== pin.samples) {
        rmSync(out, { recursive: true, force: true });
        throw new Error(
            `Clicky library count mismatch: unpacked ${actual.sets} sets and ${actual.samples} samples; ` +
                `the pin says ${pin.sets} sets and ${pin.samples} samples. ` +
                `Remove the cached library at ${source} and rebuild to download it again.`
        );
    }
}

/** Past this, a failed certificate is not followed by the next one on its own: in a terminal the user picks. */
const SIGN_ATTEMPTS_BUDGET_MS = 10_000;

interface CodesignAttemptResult {
    code: number;
    stderr: string;
}

async function runCodesign({
    args,
    timeoutMs = SIGN_ATTEMPTS_BUDGET_MS,
    runCommand = boundedCommand,
}: {
    args: string[];
    timeoutMs?: number;
    runCommand?: typeof boundedCommand;
}): Promise<CodesignAttemptResult> {
    const result = await runCommand({ command: ["codesign", ...args], timeoutMs });
    const failure = result.error
        ? result.error.code === "ETIMEDOUT"
            ? `codesign attempt timed out after ${timeoutMs} ms and was terminated: it was most likely waiting on the keychain's password dialog. Click Always Allow there, or run ${CODESIGN_TRUST_COMMAND} once; otherwise choose another certificate.`
            : `codesign attempt could not complete: ${result.error.message}`
        : "";
    return {
        code: result.error ? 1 : (result.status ?? 1),
        stderr: [result.stderr.trim(), failure].filter(Boolean).join("\n"),
    };
}

/** A codesign that has not returned after this long is waiting on the keychain's password dialog. */
const SIGN_PROMPT_NOTICE_MS = 2_500;

/** The one-time command that lets codesign use the signing keys without the keychain dialog. */
export const CODESIGN_TRUST_COMMAND = "tools macos permissions codesign-trust";

/** How long the login password may take before `security` is stopped: nobody may be at the terminal. */
const CODESIGN_TRUST_TIMEOUT_MS = 180_000;

/** Records that this Mac was asked (`trusted` or `declined`), so a build asks once. */
function codesignTrustMarker(): string {
    return join(genesisAppDir(), "codesign-trust");
}

/** True once the trust was set or declined on this Mac (`trustCodesignKeys`, the first build's question). */
export function codesignTrustAnswered(): boolean {
    return existsSync(codesignTrustMarker());
}

function recordCodesignTrust(answer: "trusted" | "declined"): void {
    mkdirSync(genesisAppDir(), { recursive: true });
    writeFileSync(codesignTrustMarker(), `${answer} ${new Date().toISOString()}\n`);
}

/**
 * `security set-key-partition-list` over the login keychain's signing keys: Apple's tools, codesign among them, may
 * then use the keys without the keychain dialog. It replaces (never merges) each key's partition list, and it
 * changes every signing key in that keychain, not only the app's:
 * a private key's label is the name typed when its certificate was requested, not the certificate's name, so `-l`
 * cannot pick the app's key by the identity it signs with. Asks for the login password on the terminal and stops
 * `security` after `timeoutMs`.
 */
export async function trustCodesignKeys(
    timeoutMs = CODESIGN_TRUST_TIMEOUT_MS
): Promise<{ ok: boolean; reason?: string }> {
    const keychain = join(homedir(), "Library", "Keychains", "login.keychain-db");
    const proc = Bun.spawn({
        cmd: ["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", keychain],
        // security prints every key it touched to stdout (attribute dumps, a screen per key); the password
        // prompt and errors are on stderr, so only those reach the terminal.
        stdio: ["inherit", "ignore", "inherit"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
        return { ok: false, reason: `no password within ${Math.round(timeoutMs / 1000)} s, so security was stopped` };
    }

    if (code !== 0) {
        return { ok: false, reason: `security exited ${code}` };
    }

    recordCodesignTrust("trusted");
    return { ok: true };
}

/**
 * The first build in a terminal offers the trust once, so a fresh install does not meet the keychain dialog on every
 * build. Without a terminal there is nobody to type the password: the build signs as before, and the notification
 * names the command. The answer defaults to No: the change is keychain-wide, so Enter alone must not make it.
 */
export async function offerCodesignTrust(step: (message: string) => void): Promise<void> {
    const yes = await p.confirm({
        message:
            "First build on this Mac: let codesign use the login keychain's signing keys without the password dialog? " +
            "It asks for your macOS login password once and replaces the partition list of every signing key in the " +
            "login keychain with Apple's tools, so another app a key listed loses that entry.",
        initialValue: false,
    });

    if (!yes) {
        recordCodesignTrust("declined");
        step(`codesign trust declined; ${CODESIGN_TRUST_COMMAND} sets it later`);
        return;
    }

    const result = await trustCodesignKeys();
    step(
        result.ok
            ? "codesign trust set: later builds sign without the keychain dialog"
            : `codesign trust not set (${result.reason}); the keychain may ask during this build`
    );
}

/**
 * Why the Mac is asking for a password, said where the user is looking: the keychain dialog names only
 * "codesign", so a build that stalls on it looked like a hang, on every build (2026-10-19). Posted
 * once per build, and only when an attempt has run past the dialog's usual appearance.
 */
export function codesignPromptNotice(identityName: string): Promise<boolean> {
    return dispatchNotification({
        app: "macos",
        title: "GenesisTools build: codesign needs the keychain",
        subtitle: identityName,
        message: `Click Always Allow in the dialog, or run ${CODESIGN_TRUST_COMMAND} once to stop these prompts.`,
        group: "genesis-app-codesign-prompt",
        // The certificate name stays on this Mac: no webhook or chat channel gets it.
        only: ["system"],
    }).catch(() => false);
}

/**
 * Signs the staged bundle. A name two keychain certificates share is signed by hash, first one first; when it fails
 * the next one is tried, on the bundle already built, so nothing is compiled again. Once the attempts took more than
 * 10 s, a terminal asks which certificate to use instead of going on alone. `preferHash` (the certificate the last
 * build signed with) goes first, so the key macOS already lets codesign use is tried before one that prompts.
 * Returns the hash that signed, when signing went by hash.
 */
export async function signStagedBundle({
    stagedBundle,
    identity,
    step,
    preferHash,
    timeoutMs = SIGN_ATTEMPTS_BUDGET_MS,
    runCommand = boundedCommand,
    onPrompt = codesignPromptNotice,
}: {
    stagedBundle: string;
    identity: CodesignIdentity;
    step: (message: string) => void;
    preferHash?: string;
    timeoutMs?: number;
    runCommand?: typeof boundedCommand;
    onPrompt?: (identityName: string) => Promise<boolean>;
}): Promise<string | undefined> {
    const name = identity.kind === "adhoc" ? "ad-hoc" : identity.name;
    let noticed = false;
    const sign = async (arg: string) => {
        const timer = setTimeout(() => {
            if (!noticed && identity.kind !== "adhoc") {
                noticed = true;
                void onPrompt(name);
            }
        }, SIGN_PROMPT_NOTICE_MS);

        try {
            return await runCodesign({
                args: [
                    "--force",
                    "--sign",
                    arg,
                    "--identifier",
                    GENESIS_APP_BUNDLE_ID,
                    "--timestamp=none",
                    stagedBundle,
                ],
                timeoutMs,
                runCommand,
            });
        } finally {
            clearTimeout(timer);
        }
    };

    if (identity.kind === "adhoc" || !identity.hashes) {
        const result = await sign(identity.kind === "adhoc" ? "-" : identity.name);

        if (result.code !== 0) {
            throw new Error(`codesign failed (exit ${result.code}):\n${result.stderr}`);
        }

        return undefined;
    }

    return await signByHashes({
        name: identity.name,
        hashes: preferredFirst(identity.hashes, preferHash),
        sign,
        step,
        choose: isInteractive()
            ? async (name, hashes) =>
                  String(
                      await p.select({
                          message: `Signing is slow. Which "${name}" certificate should sign GenesisTools.app?`,
                          options: hashes.map((value) => ({ value, label: value })),
                      })
                  )
            : undefined,
    });
}

/** `hashes` with `preferred` moved to the front when it is among them; the list order otherwise. */
export function preferredFirst(hashes: string[], preferred?: string): string[] {
    return preferred && hashes.includes(preferred)
        ? [preferred, ...hashes.filter((hash) => hash !== preferred)]
        : hashes;
}

/**
 * Tries each certificate hash in order until one signs. After a failure, once the attempts took more than 10 s,
 * `choose` (a terminal prompt; absent outside one) picks the next certificate instead of the list order.
 */
export async function signByHashes(options: {
    name: string;
    hashes: string[];
    sign: (hash: string) => CodesignAttemptResult | Promise<CodesignAttemptResult>;
    step: (message: string) => void;
    choose?: (name: string, hashes: string[]) => Promise<string>;
    now?: () => number;
}): Promise<string> {
    const now = options.now ?? (() => performance.now());
    const started = now();
    const left = [...options.hashes];
    const failures: string[] = [];

    while (left.length > 0) {
        const slow = failures.length > 0 && now() - started > SIGN_ATTEMPTS_BUDGET_MS;
        const picked = slow && options.choose ? await options.choose(options.name, [...left]) : left[0];
        const index = left.indexOf(picked);
        const hash = index >= 0 ? left.splice(index, 1)[0] : left.shift();

        if (hash === undefined) {
            break;
        }

        options.step(
            `codesign: ${options.hashes.length} certificates are named "${options.name}"; signing with ${hash.slice(0, 10)}`
        );
        const result = await options.sign(hash);

        if (result.code === 0) {
            logger.info({ name: options.name, hash, tried: failures.length + 1 }, "permissions app: signed by hash");
            return hash;
        }

        failures.push(`${hash}: ${result.stderr.trim()}`);
        logger.warn({ hash, stderr: result.stderr }, "permissions app: codesign by hash failed; trying the next one");
    }

    throw new Error(
        `codesign failed with every certificate named "${options.name}":\n${failures.join("\n")}\n` +
            "Remove the expired one in Keychain Access, or set GENESIS_TOOLS_CODESIGN_IDENTITY to the SHA-1 to use."
    );
}

/** The folder name doubles as the library's name in Clicky's Sound libraries list. */
export const CLICKY_DOWNLOADED_FOLDER = "GenesisTools sounds";

interface DownloadedClickyRegistry {
    sets: { id: string }[];
}

interface DownloadedClickyManifest {
    files: { filename: string; sha256: string }[];
}

function downloadedClickyLibraryIsComplete(out: string, pin: ClickyLibraryPin): boolean {
    try {
        const registry = SafeJSON.parse(readFileSync(join(out, "registry.json"), "utf8")) as DownloadedClickyRegistry;
        if (registry.sets.length !== pin.sets) {
            return false;
        }

        let samples = 0;
        for (const set of registry.sets) {
            const licenceBytes = readFileSync(join(out, set.id, "LICENCE.txt"));
            if (licenceBytes.length > 256 * 1024) {
                return false;
            }

            const licence = new TextDecoder("utf-8", { fatal: true }).decode(licenceBytes);
            if (!licence.trim() || licence.includes("\0")) {
                return false;
            }

            const manifest = SafeJSON.parse(
                readFileSync(join(out, set.id, "manifest.json"), "utf8")
            ) as DownloadedClickyManifest;
            for (const file of manifest.files) {
                const bytes = readFileSync(join(out, set.id, file.filename));
                if (createHash("sha256").update(bytes).digest("hex") !== file.sha256.toLowerCase()) {
                    return false;
                }

                samples++;
            }
        }

        return samples === pin.samples;
    } catch {
        return false;
    }
}

/**
 * The "Download sound pack" button in Clicky's settings (`tools macos clicky-library download`): the same pinned
 * release asset the build bundles, downloaded once, verified and unpacked OUTSIDE the signed bundle (writing into it
 * would break the signature), so Clicky can add it as a library folder. A second call reuses the unpacked folder.
 */
export async function downloadClickyLibrary({
    pinPath = join(APP_SOURCE_DIR, CLICKY_LIBRARY_PIN),
    root = genesisToolsDir("app", "clicky-library"),
    ensure = ensureClickyLibrary,
    unpack = unpackClickyLibrary,
}: {
    pinPath?: string;
    root?: string;
    ensure?: typeof ensureClickyLibrary;
    unpack?: typeof unpackClickyLibrary;
} = {}): Promise<{ path: string; reused: boolean }> {
    const pin = SafeJSON.parse(readFileSync(pinPath, "utf8"), { strict: true }) as ClickyLibraryPin;
    const out = join(root, pin.sha256.slice(0, 16), CLICKY_DOWNLOADED_FOLDER);

    mkdirSync(root, { recursive: true });
    return withFileLock(
        join(root, `${pin.sha256}.lock`),
        async () => {
            if (downloadedClickyLibraryIsComplete(out, pin)) {
                return { path: out, reused: true };
            }

            const staging = mkdtempSync(join(root, `.unpack-${pin.sha256.slice(0, 16)}-`));
            try {
                const source = await ensure(pin);
                const actual = await unpack(source, staging);
                if (actual.sets !== pin.sets || actual.samples !== pin.samples) {
                    throw new Error(
                        `Clicky library count mismatch: unpacked ${actual.sets} sets and ${actual.samples} samples; the pin says ${pin.sets} and ${pin.samples}.`
                    );
                }

                if (!downloadedClickyLibraryIsComplete(staging, pin)) {
                    throw new Error("Clicky library is incomplete after unpacking.");
                }

                mkdirSync(dirname(out), { recursive: true });
                rmSync(out, { recursive: true, force: true });
                renameSync(staging, out);
                logger.info(
                    { out, sets: actual.sets, samples: actual.samples },
                    "permissions app: Clicky library downloaded"
                );
                return { path: out, reused: false };
            } finally {
                rmSync(staging, { recursive: true, force: true });
            }
        },
        300_000
    );
}

interface StageAndInstallOptions {
    appDir: string;
    bundlePath: string;
    staging: string;
    contents: string;
    builtBinary: string;
    plist: string;
    iconPath: string;
    step: (message: string) => void;
    /** Reopen the long-lived faces the reap kills, from the new bundle (relaunch.ts). */
    relaunch: boolean;
    /** The optional parts the binary links (parts.ts); their bundle steps run, the others are skipped. */
    parts: readonly string[];
}

async function stageAndInstall(options: StageAndInstallOptions): Promise<BuildResult> {
    const { appDir, bundlePath, staging, contents, builtBinary, plist, iconPath, step, relaunch, parts } = options;
    await Bun.write(join(contents, "MacOS", GENESIS_APP_NAME), Bun.file(builtBinary));
    run(["chmod", "755", join(contents, "MacOS", GENESIS_APP_NAME)]);
    await Bun.write(join(contents, "PkgInfo"), "APPL????");

    await Bun.write(join(contents, "Info.plist"), plist);

    if (existsSync(iconPath)) {
        mkdirSync(join(contents, "Resources"), { recursive: true });
        await Bun.write(join(contents, "Resources", `${ICON_NAME}.icns`), Bun.file(iconPath));
    }

    const bundleSteps = bundleStepsFor(parts);

    if (bundleSteps.has("diff-viewer")) {
        await buildDiffViewer(contents, step);
    }

    if (bundleSteps.has("markdown-webview")) {
        step("copy markdown webview");
        cpSync(MARKDOWN_WEBVIEW_SOURCE, join(contents, "Resources", "webview"), { recursive: true });
    }

    if (bundleSteps.has("clicky-library")) {
        await bundleClickyLibrary({ contents, step });
    }

    const stagedBundle = join(staging, `${GENESIS_APP_NAME}.app`);
    const installed = readSignature(bundlePath);
    const identity = pickCodesignIdentity(
        run(["security", "find-identity", "-v", "-p", "codesigning"]).stdout,
        env.tools.getCodesignIdentity(),
        installed && !installed.adhoc ? installed.authority : undefined
    );

    // No identity usually means the keychain was out of reach (a sandboxed shell), not that the
    // certificate is gone. An ad-hoc build over a Developer ID one is a new app to macOS: every
    // grant would stop matching, so refuse instead of installing it.
    if (identity.kind === "adhoc" && !env.tools.getCodesignIdentity() && installed && !installed.adhoc) {
        throw new Error(
            `No code-signing identity is visible, but ${bundlePath} is signed by ${installed.authority}. ` +
                "An ad-hoc build would lose every privacy grant. Build from a shell that can read the login keychain " +
                "(not a sandboxed one), or set the signing identity to '-' to force ad-hoc on purpose."
        );
    }

    if (identity.kind !== "adhoc" && !codesignTrustAnswered() && isInteractive()) {
        await offerCodesignTrust(step);
    }

    step(`codesign (${identity.kind === "adhoc" ? "ad-hoc" : identity.name})`);
    const signedWithHash = await signStagedBundle({
        stagedBundle,
        identity,
        step,
        preferHash: readManifest()?.signedWithHash,
    });

    const verify = await runCodesign({ args: ["--verify", "--strict", stagedBundle] });

    if (verify.code !== 0) {
        throw new Error(`codesign --verify failed:\n${verify.stderr}`);
    }

    const signature = readSignature(stagedBundle) ?? { authority: "adhoc", adhoc: true };
    const manifest: AppManifest = {
        builtAt: new Date().toISOString(),
        sourceHash: sourceHash(APP_SOURCE_DIR, parts),
        ...(await readSourceInfo()),
        sourceToolsPath: APP_TOOLS_PATH,
        signedWith: signature.authority,
        signedWithHash,
        teamId: signature.teamId,
        parts: [...parts],
    };
    await Bun.write(join(staging, "manifest.json"), `${SafeJSON.stringify(manifest, null, 2)}\n`);

    step("install bundle");
    withInstallMarker(() => {
        // Builds before 2026-09-03 20:10 installed under ~/.genesis-tools/app; the bundle moved to
        // ~/Applications so the Full Disk Access picker shows it. Drop the old copy: same identity,
        // TCC rows are keyed by signature, and two copies would confuse the picker.
        const legacy = join(appDir, `${GENESIS_APP_NAME}.app`);

        if (legacy !== bundlePath && existsSync(legacy)) {
            rmSync(legacy, { recursive: true, force: true });
        }

        const previous = `${bundlePath}.previous`;
        rmSync(previous, { recursive: true, force: true });

        if (existsSync(bundlePath)) {
            renameSync(bundlePath, previous);
        }

        mkdirSync(dirname(bundlePath), { recursive: true });

        try {
            renameSync(stagedBundle, bundlePath);
            renameSync(join(staging, "manifest.json"), join(appDir, "manifest.json"));
        } catch (error) {
            // Put the old bundle back so the launcher path keeps working, then surface the failure.
            rmSync(bundlePath, { recursive: true, force: true });

            if (existsSync(previous)) {
                renameSync(previous, bundlePath);
            }

            logger.error({ error, bundlePath }, "GenesisTools.app install failed; previous bundle restored");
            throw error;
        }

        retirePreviousBundle(previous, appDir);

        // Launch Services must know the bundle, or every permission dialog falls back to the file
        // name and says "GenesisTools.app" instead of the CFBundleDisplayName "GenesisTools".
        step("register with Launch Services");
        unregisterStaleCopies(bundlePath);
        const lsregister = run([LSREGISTER, "-f", bundlePath]);

        if (lsregister.code !== 0) {
            logger.warn(
                { code: lsregister.code, stderr: lsregister.stderr },
                "lsregister failed; dialogs may show the file name"
            );
        }
    });

    step("pack retired bundles");
    await packRetiredBundles(retiredRootFor(appDir));

    step("reap stale app-face processes");
    await reapStaleAppFaces({ step, relaunch, parts });

    logger.info({ bundlePath, signedWith: signature.authority }, "GenesisTools.app built");

    return { bundlePath, identity, signature, manifest };
}

/**
 * Holds the install marker around the bundle swap, so native commands refuse for this second only,
 * not for the whole build. The owner and the window's length go to the log.
 */
function withInstallMarker(swap: () => void): void {
    const markerPath = genesisAppInstallMarkerPath();
    writePidFile(markerPath);
    const openedAt = Date.now();
    logger.info({ markerPath }, "app install window open: native commands are refused until the bundle is swapped");

    try {
        swap();
    } finally {
        clearPidFile(markerPath);
        logger.info({ markerPath, ms: Date.now() - openedAt }, "app install window closed");
    }
}

/**
 * Where replaced bundles go. `.noindex` keeps Spotlight out: Spotlight registers every app bundle it
 * indexes with Launch Services, which undid the `lsregister -u` below, and `open -b` then handed
 * links to a retired copy whose router predated the current config (2026-09-30: a
 * `https://dashboard/` link looped through the browser extension, one new tab every half second).
 */
export function retiredRootFor(appDir: string): string {
    return join(appDir, "retired.noindex");
}

/**
 * Moves the replaced bundle to `<appDir>/retired.noindex/<ms>/` instead of deleting it.
 *
 * Every `tools` process, and every Claude session started through `gt-cc`, runs inside this
 * app's binary and keeps the one it started with. macOS judges Full Disk Access by that
 * responsible process. With its binary deleted, tccd logs "proc_pidpath_audittoken() failed:
 * No such file or directory", cannot resolve the process, and denies the grant, so every
 * session started before a rebuild lost Messages, Mail and Voice Memos (2026-09-24 13:53).
 * A moved file keeps a path, so tccd still resolves it and the grant still matches.
 */
function retirePreviousBundle(previous: string, appDir: string): void {
    if (!existsSync(previous)) {
        return;
    }

    const retiredRoot = retiredRootFor(appDir);
    const retiredAt = Date.now();
    const target = join(retiredRoot, String(retiredAt), `${GENESIS_APP_NAME}.app`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(previous, target);
    adoptLegacyRetired(appDir, retiredRoot);
    // Launch Services must never offer a retired copy: not in the Full Disk Access picker, and not
    // to `open -b`. Unregistered BEFORE the pack (`packRetiredBundles`, after the install window): a copy
    // removed while still registered left a record pointing at a missing path, which the notification
    // center then tried to launch for every click. A packed `<ms>.zst` is a file, never a bundle, so
    // lsregister is never pointed at one.
    for (const entry of readdirSync(retiredRoot, { withFileTypes: true })) {
        const bundle = join(retiredRoot, entry.name, `${GENESIS_APP_NAME}.app`);

        if (entry.isDirectory() && existsSync(bundle)) {
            run([LSREGISTER, "-u", bundle]);
        }
    }
}

/**
 * Every Launch Services record of this bundle id at another path, from `lsregister -dump`. Its blocks are
 * separated by dashed lines; a record keeps its `path:` after the bundle is gone ("Bundle node not found").
 */
export function staleRegistrations(dump: string, bundleId: string, keepPath: string): string[] {
    const stale = new Set<string>();

    for (const block of dump.split(/\n-{20,}\n/)) {
        const identifier = block.match(/^identifier:\s+(\S+)\s*$/m)?.[1];
        const path = block.match(/^path:\s+(.+?)\s+\(0x[0-9a-f]+\)\s*$/m)?.[1];

        if (identifier === bundleId && path && resolve(path) !== resolve(keepPath)) {
            stale.add(path);
        }
    }

    return [...stale];
}

/**
 * usernoted launches the REGISTERED copy to deliver a banner click. With the only record pointing at a deleted
 * retired copy, the launch failed and every click on a running hub was dropped (2026-10-06: "Foreground launch of
 * com.genesiscz.genesistools failed", no response delivered). So every record but the installed bundle goes.
 */
const STALE_COPY_CHECK_EVERY_MS = 24 * 3_600_000;

function unregisterStaleCopies(bundlePath: string): void {
    // The dump costs about 6 s of a build. A dead record only appears when a still-registered copy is deleted, which
    // the build itself no longer does (retired copies are unregistered before the prune), so once a day is enough.
    const stampPath = join(genesisAppDir(), "ls-stale-check.stamp");
    try {
        if (Date.now() - statSync(stampPath).mtimeMs < STALE_COPY_CHECK_EVERY_MS) {
            logger.debug({ stampPath }, "stale LaunchServices copies checked within a day; skipping the dump");
            return;
        }
    } catch (error) {
        logger.debug({ error, stampPath }, "no stale-copy check stamp yet; running the dump");
    }

    const dump = run([LSREGISTER, "-dump"]);

    if (dump.code !== 0) {
        logger.warn(
            { code: dump.code, stderr: dump.stderr.slice(0, 400) },
            "lsregister -dump failed; stale copies stay"
        );
        return;
    }

    const stale = staleRegistrations(dump.stdout, GENESIS_APP_BUNDLE_ID, bundlePath);

    for (const path of stale) {
        run([LSREGISTER, "-u", path]);
    }

    logger.info({ stale }, "unregistered stale GenesisTools.app copies");
    writeFileSync(stampPath, `${new Date().toISOString()}\n`);
}

/** Copies retired before `retired.noindex` existed move in; a move keeps the path tccd resolves live. */
function adoptLegacyRetired(appDir: string, retiredRoot: string): void {
    const legacy = join(appDir, "retired");

    if (!existsSync(legacy)) {
        return;
    }

    for (const entry of readdirSync(legacy, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            renameSync(join(legacy, entry.name), join(retiredRoot, entry.name));
        }
    }

    logger.debug({ legacy, retiredRoot }, "moved retired bundles out of Spotlight's reach");
}

/**
 * The inode of every running executable among `pids`. An inode survives the move to `retired.noindex`, and the kernel's
 * executable path follows the move, so the inode read through it is the running binary's own. A process whose
 * executable cannot be read is skipped: `kernel_task` has none, and a binary an upgrade deleted is no bundle that could
 * still be pruned. `null` keeps every bundle: no readable process at all means the listing failed, not that nothing
 * runs.
 */
export function runningExecutableInodes(pids: number[], inodeOf: (pid: number) => number | null): Set<number> | null {
    const inodes = new Set<number>();

    for (const pid of pids) {
        const inode = inodeOf(pid);

        if (inode !== null) {
            inodes.add(inode);
        }
    }

    return inodes.size === 0 ? null : inodes;
}

/** Retired bundles kept as folders for a quick rollback; older idle ones are packed into `<ms>.zst`. */
export const RETIRED_KEEP_FOLDERS = 2;
/** At most this many packed bundles stay, and none older than {@link RETIRED_ARCHIVE_MAX_AGE_DAYS}. */
export const RETIRED_MAX_ARCHIVES = 5;
export const RETIRED_ARCHIVE_MAX_AGE_DAYS = 14;

/**
 * Retired bundles that must stay folders whatever their age: every one whose binary a running process
 * still executes, since tccd resolves that process by the binary's path, and every one whose binary
 * cannot be stat'ed (it cannot be shown to be idle).
 */
export function pinnedRetiredBundles({
    entries,
    inodeOf,
    running,
}: {
    /** Directory names under the retired root, each a retirement time in ms. */
    entries: string[];
    inodeOf: (entry: string) => number | null;
    running: Set<number>;
}): Set<string> {
    return new Set(
        entries.filter((entry) => {
            const inode = inodeOf(entry);
            return inode === null || running.has(inode);
        })
    );
}

/** {@link runningExecutableInodes} of every process on this machine, read from the kernel. */
export function readRunningExecutableInodes(): Set<number> | null {
    return runningExecutableInodes(
        listProcesses({ commands: false }).map((entry) => entry.pid),
        executableInode
    );
}

/**
 * The retired copies under `root` (folders named by their retirement time in ms), newest first. Empty when `root` does
 * not exist yet; null when it could not be read (logged with `root`), so a caller deletes nothing on a guess.
 */
export function listRetiredStamps(root: string): string[] | null {
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && Number.isFinite(Number(entry.name)))
            .map((entry) => entry.name)
            .sort((a, b) => Number(b) - Number(a));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }

        logger.warn({ error, root }, "retired copies not listed; none deleted");
        return null;
    }
}

/**
 * The retired copies to delete, from `stamps` newest first: those past the newest `keep`, except a pinned one
 * ({@link pinnedRetiredBundles}: a running process still executes its binary, or the binary cannot be stat'ed).
 * Running processes that could not be listed (`running` null) delete nothing.
 */
export function retiredStampsToDelete({
    stamps,
    keep,
    running,
    inodeOf,
}: {
    stamps: string[];
    keep: number;
    running: Set<number> | null;
    inodeOf: (stamp: string) => number | null;
}): string[] {
    if (running === null) {
        return [];
    }

    const pinned = pinnedRetiredBundles({ entries: stamps, inodeOf, running });
    return stamps.slice(keep).filter((stamp) => !pinned.has(stamp));
}

/** Deletes each stamp folder under `root`; a failure is logged and the rest still go. Returns the deleted stamps. */
export function deleteRetiredStamps(root: string, stamps: string[]): string[] {
    return stamps.filter((stamp) => {
        try {
            rmSync(join(root, stamp), { recursive: true, force: true });
            return true;
        } catch (error) {
            logger.warn({ error, root, stamp }, "retired copy not deleted");
            return false;
        }
    });
}

/**
 * Keeps the newest {@link RETIRED_KEEP_FOLDERS} retired bundles and every pinned one as folders, packs the
 * other idle ones into `<ms>.zst` (tar inside seekable zstd, checked file by file before the folder goes;
 * restore with `tools compress unpack`), and removes packed copies past the count or age cap. Runs after
 * the install window, so native commands are refused only for the swap. A failure is logged, never fatal.
 */
export async function packRetiredBundles(retiredRoot: string): Promise<void> {
    if (!existsSync(retiredRoot)) {
        return;
    }

    const running = readRunningExecutableInodes();
    if (running === null) {
        logger.debug("cannot list running executables; keeping retired bundles");
        return;
    }

    const entries = readdirSync(retiredRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && Number.isFinite(Number(entry.name)))
        .map((entry) => entry.name);
    const binary = (entry: string) =>
        join(retiredRoot, entry, `${GENESIS_APP_NAME}.app`, "Contents", "MacOS", GENESIS_APP_NAME);
    const pinned = pinnedRetiredBundles({
        entries,
        running,
        inodeOf: (entry) => (existsSync(binary(entry)) ? statSync(binary(entry)).ino : null),
    });

    try {
        const plan = planFolderRetention({
            root: retiredRoot,
            keep: RETIRED_KEEP_FOLDERS,
            include: (name) => Number.isFinite(Number(name)),
            pin: (name) => pinned.has(name),
            timeOf: ({ name }) => Number(name),
            maxArchives: RETIRED_MAX_ARCHIVES,
            maxArchiveAgeDays: RETIRED_ARCHIVE_MAX_AGE_DAYS,
        });
        const report = await applyFolderRetention(plan, { caller: "app-retired", preset: PRESETS.binary });
        logger.info(
            {
                kept: plan.kept.length,
                pinned: pinned.size,
                packed: report.packed.length,
                removed: plan.drop.length + plan.deleteArchives.length,
                failed: report.failed.length,
            },
            "packed retired app bundles"
        );
    } catch (error) {
        logger.warn({ error, retiredRoot }, "packing retired app bundles failed; they stay as they are");
    }
}

const STALE_FACE_TERM_GRACE_MS = 500;

/**
 * Read-only process snapshot shared by the reap and its pre-kill recheck, oldest first: the faces start again in this
 * order, and the kernel table lists the newest first.
 */
export function readAppFaceProcesses(): ProcessEntry[] {
    return listProcesses().sort(
        (a, b) => (a.startMs ?? Number.POSITIVE_INFINITY) - (b.startMs ?? Number.POSITIVE_INFINITY) || a.pid - b.pid
    );
}

export function staleAppFacePids(processes: Pick<ProcessEntry, "pid" | "command">[], launcherPath: string): string[] {
    const stale: string[] = [];

    for (const entry of processes) {
        if (entry.command === null) {
            continue;
        }

        // The launcher path has to end at a word boundary: a sibling binary whose name merely
        // starts with it (`GenesisTools-helper`) would otherwise leave a `-helper` rest and read
        // as a flag-argument face.
        const command = entry.command;
        const boundary = command[launcherPath.length];
        if (!command.startsWith(launcherPath) || (boundary !== undefined && !/\s/.test(boundary))) {
            continue;
        }

        const rest = command.slice(launcherPath.length).trim();

        // "" is the settings window; a leading dash is --rpc / --window / --notify; an http(s) link is a link
        // router, which ends within seconds, so one that is still there holds every later link and drops it
        // (2026-10-06: 5 h). Anything else starts with a program path, which means it is the launcher and
        // must be left alone.
        if (rest === "" || rest.startsWith("-") || /^https?:\/\//.test(rest)) {
            stale.push(String(entry.pid));
        }
    }

    return stale;
}

/**
 * Kill app-face processes left over from the bundle this install just replaced.
 *
 * 🛑 This is not tidiness, it is correctness. macOS delivers a notification click to the bundle's
 * ALREADY-RUNNING instance and only launches a fresh one when none exists. A settings window or an
 * `--rpc` process from an older build therefore keeps receiving every click and answers with
 * whatever code it was built from — silently, since it looks exactly like a working app. That cost
 * two hours on 2026-09-16: a window instance from 13:48 swallowed every click for the rest of the
 * session, and a hung `--rpc` process spun at 60% CPU for an hour doing the same.
 *
 * ⚠️ Only argument-less, flag-argument and link-router (`GenesisTools https://…`) faces are killed. `GenesisTools <program> [args...]` is
 * the LAUNCHER running somebody's actual work (a dev server, an editor session, a long build), and
 * killing those would take the user's tools down with the rebuild.
 *
 * SIGTERM first, then SIGKILL for anyone still alive after {@link STALE_FACE_TERM_GRACE_MS}.
 *
 * The settings, hub, review, widget and Clicky faces among them, and the link relay, start again from the
 * new bundle with the argv they had, behind the front app (relaunch.ts), unless `relaunch` is false
 * (`tools macos permissions build --no-relaunch`).
 */
async function reapStaleAppFaces({
    step,
    relaunch,
    parts,
}: {
    step: (message: string) => void;
    relaunch: boolean;
    /** The parts the new bundle links: a reaped face of another part does not come back (it could not run). */
    parts: readonly string[];
}): Promise<void> {
    const launcher = genesisAppLauncherPath();
    const listing = readAppFaceProcesses();
    if (listing.length === 0) {
        logger.debug("could not list processes; skipping the stale-face reap");
        return;
    }

    const stale = staleAppFacePids(listing, launcher);

    if (stale.length === 0) {
        return;
    }

    // The long-lived faces among them, with their exact argv, recorded before anything is killed.
    let reopen: RelaunchCapture = { steps: [], relay: false };

    if (relaunch) {
        // A failed capture only costs the reopen; the reap below must still run.
        try {
            reopen = captureRelaunch({ processes: listing, launcherPath: launcher, stalePids: stale });
        } catch (err) {
            // The relay decision needs only the listing, so a relay that was running still comes back.
            const relay = linkRelayAmong({
                processes: listing,
                launcherPath: launcher,
                stalePids: new Set(stale),
            });
            reopen = { steps: [], relay };
            logger.warn({ err, relay }, "relaunch: faces could not be recorded; they stay closed after the reap");
        }
    } else {
        logger.info("relaunch: off (--no-relaunch); reaped faces stay closed");
    }

    try {
        await killStaleFaces(stale, launcher, step);
    } finally {
        if (relaunch) {
            const steps = reopen.steps.filter((face) => {
                const part = partForFace(face.argv[0] ?? "");
                return part === undefined || parts.includes(part);
            });
            runRelaunch({ ...reopen, steps }, step);
        }
    }
}

async function killStaleFaces(stale: string[], launcher: string, step: (message: string) => void): Promise<void> {
    step(`killing ${stale.length} stale app-face process(es): ${stale.join(" ")}`);

    for (const pid of stale) {
        try {
            // pid-verified: live ps listing of stale GenesisTools faces
            process.kill(Number(pid), "SIGTERM");
        } catch (err) {
            logger.debug({ err, pid }, "stale app-face already gone at SIGTERM");
        }
    }

    await Bun.sleep(STALE_FACE_TERM_GRACE_MS);

    // A pid freed during the grace period can be reused, so classify the pids again instead of
    // trusting liveness alone.
    const stillStale = new Set(staleAppFacePids(readAppFaceProcesses(), launcher));
    const survivors = stale.filter((pid) => stillStale.has(pid) && isProcessAlive(Number(pid)));

    for (const pid of survivors) {
        try {
            // pid-verified: re-read ps after the grace; still classified as a stale GenesisTools face
            process.kill(Number(pid), "SIGKILL");
            logger.info({ pid }, "escalated stale app-face to SIGKILL");
        } catch (err) {
            logger.debug({ err, pid }, "stale app-face already gone at SIGKILL");
        }
    }

    logger.info(
        { pids: stale, killed: survivors.length },
        "reaped GenesisTools app-face processes from the replaced bundle"
    );
}
