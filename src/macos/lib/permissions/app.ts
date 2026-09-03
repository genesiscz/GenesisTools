import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    GENESIS_APP_BUNDLE_ID,
    GENESIS_APP_NAME,
    genesisAppBundlePath,
    genesisAppDir,
    genesisAppLauncherPath,
} from "@genesiscz/utils/macos/genesis-app";
import { withFileLock } from "@genesiscz/utils/storage";

export const APP_SOURCE_DIR = resolve(import.meta.dirname, "../../GenesisTools");
const SOURCE_ROOTS = ["Package.swift", "Info.plist", "Sources", "scripts/AppIcon.icns"];
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

export interface AppManifest {
    builtAt: string;
    sourceHash: string;
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
            hash.update(file.slice(sourceDir.length));
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
    const stale = built && manifest !== undefined && manifest.sourceHash !== sourceHash();

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

/**
 * swift build → assemble bundle → codesign → manifest. Replaces the bundle atomically.
 *
 * Serialized across processes: two concurrent `permissions build` runs share one `.previous`
 * backup, so without the lock the second run could delete the first run's backup and leave a
 * failed swap with nothing to restore. The timeout covers a cold `swift build`.
 */
export async function buildApp(options?: { onStep?: (message: string) => void }): Promise<BuildResult> {
    mkdirSync(genesisAppDir(), { recursive: true });

    return withFileLock(
        join(genesisAppDir(), "build.lock"),
        async () => {
            // Holding the lock means no other build owns a staging directory, so anything left
            // here is debris from a crashed run and is safe to drop.
            sweepAbandonedStaging();
            return buildAppLocked(options);
        },
        BUILD_LOCK_TIMEOUT_MS
    );
}

async function buildAppLocked(options?: { onStep?: (message: string) => void }): Promise<BuildResult> {
    const step = options?.onStep ?? (() => {});

    if (process.platform !== "darwin") {
        throw new Error("GenesisTools.app can only be built on macOS.");
    }

    if (!Bun.which("swift")) {
        throw new Error("swift not found. Install Xcode or the Command Line Tools, then re-run.");
    }

    step("swift build -c release");
    const build = run(["swift", "build", "-c", "release"], APP_SOURCE_DIR);

    if (build.code !== 0) {
        throw new Error(`swift build failed (exit ${build.code}):\n${build.stderr || build.stdout}`);
    }

    const builtBinary = join(APP_SOURCE_DIR, ".build", "release", GENESIS_APP_NAME);

    if (!existsSync(builtBinary)) {
        throw new Error(`swift build produced no binary at ${builtBinary}`);
    }

    step("assemble bundle");
    const plist = stampInfoPlist(
        readFileSync(join(APP_SOURCE_DIR, "Info.plist"), "utf8"),
        Math.floor(Date.now() / 1000)
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
        return await stageAndInstall({ appDir, bundlePath, staging, contents, builtBinary, plist, iconPath, step });
    } finally {
        // Every failure between here and the swap (codesign, verify, rename) used to leave a
        // half-built bundle under ~/.genesis-tools/app; one finally covers them all.
        rmSync(staging, { recursive: true, force: true });
    }
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
}

async function stageAndInstall(options: StageAndInstallOptions): Promise<BuildResult> {
    const { appDir, bundlePath, staging, contents, builtBinary, plist, iconPath, step } = options;
    await Bun.write(join(contents, "MacOS", GENESIS_APP_NAME), Bun.file(builtBinary));
    run(["chmod", "755", join(contents, "MacOS", GENESIS_APP_NAME)]);
    await Bun.write(join(contents, "PkgInfo"), "APPL????");

    await Bun.write(join(contents, "Info.plist"), plist);

    if (existsSync(iconPath)) {
        mkdirSync(join(contents, "Resources"), { recursive: true });
        await Bun.write(join(contents, "Resources", `${ICON_NAME}.icns`), Bun.file(iconPath));
    }

    const stagedBundle = join(staging, `${GENESIS_APP_NAME}.app`);
    const identity = pickCodesignIdentity(
        run(["security", "find-identity", "-v", "-p", "codesigning"]).stdout,
        env.tools.getCodesignIdentity()
    );
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
        signedWith: signature.authority,
        teamId: signature.teamId,
    };
    await Bun.write(join(staging, "manifest.json"), `${SafeJSON.stringify(manifest, null, 2)}\n`);

    step("install bundle");
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

    rmSync(previous, { recursive: true, force: true });

    // Launch Services must know the bundle, or every permission dialog falls back to the file
    // name and says "GenesisTools.app" instead of the CFBundleDisplayName "GenesisTools".
    step("register with Launch Services");
    const lsregister = run([LSREGISTER, "-f", bundlePath]);

    if (lsregister.code !== 0) {
        logger.warn(
            { code: lsregister.code, stderr: lsregister.stderr },
            "lsregister failed; dialogs may show the file name"
        );
    }

    logger.info({ bundlePath, signedWith: signature.authority }, "GenesisTools.app built");

    return { bundlePath, identity, signature, manifest };
}
