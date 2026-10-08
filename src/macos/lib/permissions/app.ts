import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
import { detectXcodeToolchain, genesisAppBuildHint, type XcodeToolchain } from "@genesiscz/utils/macos/xcode";
import { clearPidFile, writePidFile } from "@genesiscz/utils/process/pidfile";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { withFileLock } from "@genesiscz/utils/storage";
import { captureRelaunch, type RelaunchStep, runRelaunch } from "./relaunch";

export const APP_SOURCE_DIR = resolve(import.meta.dirname, "../../GenesisTools");
/** The app build's own SwiftPM scratch folder, apart from `.build/debug` (tests, benches) so the two never rebuild each other. */
const APP_SCRATCH_PATH = join(APP_SOURCE_DIR, ".build", "opt");
export const APP_TOOLS_PATH = resolve(APP_SOURCE_DIR, "../../../tools");
/** The shared SwiftUI package the app links (src/macos/GenesisKit), so an edit there marks the build stale too. */
const SOURCE_ROOTS = [
    "Package.swift",
    "Info.plist",
    "Sources",
    "scripts/AppIcon.icns",
    "web",
    "../GenesisKit/Package.swift",
    "../GenesisKit/Sources",
];
/** Browser half of the diff renderer (PierreWebDiffRenderer.swift): bundled into Contents/Resources/diff-viewer. */
const DIFF_VIEWER_SOURCE = "web/diff-viewer";
const ICON_SOURCE = "scripts/AppIcon.icns";
const ICON_GENERATOR = "scripts/build-icon.swift";
/** Info.plist CFBundleIconFile value; the file lands at Contents/Resources/AppIcon.icns. */
const ICON_NAME = "AppIcon";
/** A cold `swift build` of the launcher takes about a minute; leave room for a slower machine. */
const BUILD_LOCK_TIMEOUT_MS = 240_000;
const PLIST_VERSION_MARKER = "<string>0.0.0</string>";
const PLIST_BUILD_MARKER = "<key>CFBundleVersion</key>\n\t<string>1</string>";
const LSREGISTER =
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
    teamId?: string;
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
    /** ad-hoc signatures change on every build, so TCC forgets the grants each time */
    identityStable: boolean;
}

export type CodesignIdentity =
    | { kind: "developer-id" | "apple-development" | "custom"; name: string }
    | { kind: "adhoc" };

function run(cmd: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
    logger.debug({ cmd, cwd }, "permissions app: spawn");
    const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
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

/** Every file under the source roots, so a new Swift file or a re-rendered icon marks the build stale. */
export function sourceHash(sourceDir = APP_SOURCE_DIR): string {
    const hash = createHash("sha256");

    for (const root of SOURCE_ROOTS) {
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

/** Pick the most durable signing identity present: Developer ID, then Apple Development, else ad-hoc. */
export function pickCodesignIdentity(findIdentityOutput: string, override?: string): CodesignIdentity {
    if (override) {
        return override === "-" ? { kind: "adhoc" } : { kind: "custom", name: override };
    }

    const names = [...findIdentityOutput.matchAll(/^\s*\d+\)\s+[0-9A-F]+\s+"([^"]+)"/gm)].map((m) => m[1]);
    const developerId = names.find((n) => n.startsWith("Developer ID Application:"));

    if (developerId) {
        return { kind: "developer-id", name: developerId };
    }

    const appleDev = names.find((n) => n.startsWith("Apple Development:"));

    if (appleDev) {
        return { kind: "apple-development", name: appleDev };
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
    const stale =
        built &&
        manifest !== undefined &&
        (manifest.sourceHash !== sourceHash() ||
            (manifest.sourceToolsPath !== undefined && manifest.sourceToolsPath !== APP_TOOLS_PATH));

    return {
        bundlePath,
        launcherPath,
        built,
        manifest,
        signature,
        stale,
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
    /** false leaves the reaped hub, review and settings windows closed (`--no-relaunch`); default true. */
    relaunch?: boolean;
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
 * Refuses before `swift build` ever runs when the active toolchain is the Command Line Tools
 * (or nothing at all): GenesisKit's SwiftUI macros (`@State`, `@Entry`) need the `SwiftUIMacros`
 * compiler plugin, which ships only with full Xcode, and a build without it fails with 100+
 * cascading "plugin for module 'SwiftUIMacros' not found" errors instead of one clear message (#445).
 */
export function assertFullXcodeToolchain(toolchain: XcodeToolchain): void {
    if (toolchain.kind !== "xcode") {
        throw new Error(genesisAppBuildHint(toolchain));
    }
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
        return await buildAppSteps(timer.step, options?.relaunch !== false);
    } finally {
        const summary = timer.summary();
        logger.info({ summary }, "GenesisTools.app build timings");
        options?.onStep?.(summary);
    }
}

async function buildAppSteps(step: (message: string) => void, relaunch: boolean): Promise<BuildResult> {
    if (process.platform !== "darwin") {
        throw new Error("GenesisTools.app can only be built on macOS.");
    }

    if (!Bun.which("swift")) {
        throw new Error("swift not found. Install Xcode or the Command Line Tools, then re-run.");
    }

    assertFullXcodeToolchain(detectXcodeToolchain());

    // SwiftPM's debug configuration with `-O`, in its own scratch folder: release mode is never incremental, so one
    // changed line recompiled all 91 files of the app (58.7 s with whole-module optimization, 18.3 s without), while
    // this rebuilds the changed files only (5.1 s). `-O` is what the compile line carries (no `-Onone`), and no source
    // uses `#if DEBUG`. Hub resize bench, interleaved 3+3 runs (2026-10-07): sidebar p50 8.6/8.1/9.1 vs release
    // 8.6/9.5/8.8 ms, split 10.3/10.1/10.1 vs 10.3/10.0/10.2, window 17.0-17.2 vs 16.6-17.4.
    step("swift build (optimized, incremental)");
    const build = run(
        ["swift", "build", "-c", "debug", "-Xswiftc", "-O", "--scratch-path", APP_SCRATCH_PATH],
        APP_SOURCE_DIR
    );

    if (build.code !== 0) {
        throw new Error(`swift build failed (exit ${build.code}):\n${build.stderr || build.stdout}`);
    }

    const builtBinary = join(APP_SCRATCH_PATH, "debug", GENESIS_APP_NAME);

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
        const icon = run(["swift", join(APP_SOURCE_DIR, ICON_GENERATOR)], APP_SOURCE_DIR);

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
async function buildDiffViewer(contents: string, step: (message: string) => void): Promise<void> {
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

interface StageAndInstallOptions {
    appDir: string;
    bundlePath: string;
    staging: string;
    contents: string;
    builtBinary: string;
    plist: string;
    iconPath: string;
    step: (message: string) => void;
    /** Reopen the window faces the reap kills, from the new bundle (relaunch.ts). */
    relaunch: boolean;
}

async function stageAndInstall(options: StageAndInstallOptions): Promise<BuildResult> {
    const { appDir, bundlePath, staging, contents, builtBinary, plist, iconPath, step, relaunch } = options;
    await Bun.write(join(contents, "MacOS", GENESIS_APP_NAME), Bun.file(builtBinary));
    run(["chmod", "755", join(contents, "MacOS", GENESIS_APP_NAME)]);
    await Bun.write(join(contents, "PkgInfo"), "APPL????");

    await Bun.write(join(contents, "Info.plist"), plist);

    if (existsSync(iconPath)) {
        mkdirSync(join(contents, "Resources"), { recursive: true });
        await Bun.write(join(contents, "Resources", `${ICON_NAME}.icns`), Bun.file(iconPath));
    }

    await buildDiffViewer(contents, step);

    const stagedBundle = join(staging, `${GENESIS_APP_NAME}.app`);
    const identity = pickCodesignIdentity(
        run(["security", "find-identity", "-v", "-p", "codesigning"]).stdout,
        env.tools.getCodesignIdentity()
    );
    const installed = readSignature(bundlePath);

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

    const identityArg = identity.kind === "adhoc" ? "-" : identity.name;
    step(`codesign (${identity.kind === "adhoc" ? "ad-hoc" : identity.name})`);
    const sign = run([
        "codesign",
        "--force",
        "--sign",
        identityArg,
        "--identifier",
        GENESIS_APP_BUNDLE_ID,
        "--timestamp=none",
        stagedBundle,
    ]);

    if (sign.code !== 0) {
        throw new Error(`codesign failed (exit ${sign.code}):\n${sign.stderr}`);
    }

    const verify = run(["codesign", "--verify", "--strict", stagedBundle]);

    if (verify.code !== 0) {
        throw new Error(`codesign --verify failed:\n${verify.stderr}`);
    }

    const signature = readSignature(stagedBundle) ?? { authority: "adhoc", adhoc: true };
    const manifest: AppManifest = {
        builtAt: new Date().toISOString(),
        sourceHash: sourceHash(),
        ...(await readSourceInfo()),
        sourceToolsPath: APP_TOOLS_PATH,
        signedWith: signature.authority,
        teamId: signature.teamId,
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

    step("reap stale app-face processes");
    await reapStaleAppFaces(step, relaunch);

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
    // to `open -b`. Unregistered BEFORE the prune: a copy deleted while still registered left a record
    // pointing at a missing path, which the notification center then tried to launch for every click.
    for (const entry of readdirSync(retiredRoot, { withFileTypes: true })) {
        const bundle = join(retiredRoot, entry.name, `${GENESIS_APP_NAME}.app`);

        if (entry.isDirectory() && existsSync(bundle)) {
            run([LSREGISTER, "-u", bundle]);
        }
    }

    pruneRetiredBundles(retiredRoot);
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
 * The inode of every running executable, from `lsof -d txt -Fi -n`. An inode survives the move to
 * `retired.noindex`, while lsof may still print a moved binary under its old path (it named
 * `GenesisTools.app.previous` for processes whose bundle had long moved on). `null` keeps every
 * bundle: a listing that failed would otherwise read as "nothing runs", and a failed run's partial
 * output can miss the one process that still executes a retired binary.
 */
export function runningExecutableInodes(listing: { code: number; stdout: string }): Set<number> | null {
    if (listing.code !== 0) {
        return null;
    }

    const inodes = new Set<number>();

    for (const line of listing.stdout.split("\n")) {
        const inode = line.startsWith("i") ? Number(line.slice(1)) : Number.NaN;

        if (Number.isInteger(inode)) {
            inodes.add(inode);
        }
    }

    return inodes.size === 0 ? null : inodes;
}

/**
 * Which retired bundles stay: the newest one (one version back), and every one whose binary a
 * running process still executes, since tccd resolves that process by the binary's path.
 */
export function retiredBundlesToKeep({
    entries,
    inodeOf,
    running,
}: {
    /** Directory names under the retired root, each a retirement time in ms. */
    entries: string[];
    inodeOf: (entry: string) => number | null;
    running: Set<number>;
}): Set<string> {
    const newest = entries.reduce<string | null>(
        (best, entry) => (best === null || Number(entry) > Number(best) ? entry : best),
        null
    );
    return new Set(
        entries.filter((entry) => {
            const inode = inodeOf(entry);
            return entry === newest || inode === null || running.has(inode);
        })
    );
}

/** Deletes every retired bundle except the newest and the ones a running process executes. */
function pruneRetiredBundles(retiredRoot: string): void {
    const listing = run(["lsof", "-d", "txt", "-Fi", "-n"]);
    const running = runningExecutableInodes(listing);

    if (running === null) {
        logger.debug(
            { code: listing.code, stderr: listing.stderr },
            "cannot list running executables; keeping retired bundles"
        );
        return;
    }

    const entries = readdirSync(retiredRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && Number.isFinite(Number(entry.name)))
        .map((entry) => entry.name);
    const binary = (entry: string) =>
        join(retiredRoot, entry, `${GENESIS_APP_NAME}.app`, "Contents", "MacOS", GENESIS_APP_NAME);
    const keep = retiredBundlesToKeep({
        entries,
        running,
        inodeOf: (entry) => (existsSync(binary(entry)) ? statSync(binary(entry)).ino : null),
    });
    const removed = entries.filter((entry) => !keep.has(entry));

    for (const entry of removed) {
        rmSync(join(retiredRoot, entry), { recursive: true, force: true });
    }

    logger.info({ kept: keep.size, removed: removed.length }, "pruned retired app bundles");
}

const STALE_FACE_TERM_GRACE_MS = 500;

/** Classify `ps -Ao pid=,args=` lines. Exported so the window / `--rpc` / launcher split is tested. */
export function staleAppFacePids(psStdout: string, launcherPath: string): string[] {
    const stale: string[] = [];

    for (const line of psStdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!match) {
            continue;
        }

        // The launcher path has to end at a word boundary: a sibling binary whose name merely
        // starts with it (`GenesisTools-helper`) would otherwise leave a `-helper` rest and read
        // as a flag-argument face.
        const command = match[2];
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
            stale.push(match[1]);
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
 * The hub, review and settings windows among them start again from the new bundle with the argv they
 * had (relaunch.ts), unless `relaunch` is false (`tools macos permissions build --no-relaunch`).
 */
async function reapStaleAppFaces(step: (message: string) => void, relaunch: boolean): Promise<void> {
    const launcher = genesisAppLauncherPath();
    const listing = run(["ps", "-Ao", "pid=,args="]);

    if (listing.code !== 0) {
        logger.debug({ stderr: listing.stderr }, "could not list processes; skipping the stale-face reap");
        return;
    }

    const stale = staleAppFacePids(listing.stdout, launcher);

    if (stale.length === 0) {
        return;
    }

    // The window faces among them, with their exact argv, recorded before anything is killed.
    let reopen: RelaunchStep[] = [];

    if (relaunch) {
        // A failed capture only costs the reopen; the reap below must still run.
        try {
            reopen = captureRelaunch({ psStdout: listing.stdout, launcherPath: launcher, stalePids: stale });
        } catch (err) {
            logger.warn({ err }, "relaunch: window faces could not be recorded; they stay closed after the reap");
        }
    } else {
        logger.info("relaunch: off (--no-relaunch); reaped windows stay closed");
    }

    try {
        await killStaleFaces(stale, launcher, step);
    } finally {
        if (relaunch) {
            runRelaunch(reopen, step);
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
    const recheck = run(["ps", "-Ao", "pid=,args="]);
    const stillStale = new Set(recheck.code === 0 ? staleAppFacePids(recheck.stdout, launcher) : []);
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
