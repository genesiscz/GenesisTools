import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    constants as fsConstants,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

import type { DesktopAppInfo } from "./types";

export const CODEX_DESKTOP_BUNDLE_ID = "com.openai.codex";

const HASH = /^[0-9a-f]{64}$/;

function plistString(plist: string, key: string): string {
    const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
    const match = pattern.exec(plist);
    if (!match?.[1]) {
        throw new Error(`Info.plist has no ${key}`);
    }

    return match[1];
}

export function readDesktopApp(requestedPath: string): DesktopAppInfo {
    // One canonical path (`--app` through a symlink, a relative path, a trailing slash): the running
    // check matches the process path by prefix, and the backup is keyed by this path.
    const appPath = existsSync(requestedPath) ? realpathSync(requestedPath) : requestedPath;
    const plistPath = join(appPath, "Contents", "Info.plist");
    if (!existsSync(plistPath)) {
        throw new Error(`${appPath} has no Contents/Info.plist`);
    }

    const plist = readFileSync(plistPath, "utf8");
    if (!plist.includes("<key>")) {
        throw new Error(`${plistPath} is not an XML property list`);
    }

    const executable = plistString(plist, "CFBundleExecutable");
    const info: DesktopAppInfo = {
        appPath,
        plistPath,
        asarPath: join(appPath, "Contents", "Resources", "app.asar"),
        executablePath: join(appPath, "Contents", "MacOS", executable),
        codeResourcesPath: join(appPath, "Contents", "_CodeSignature", "CodeResources"),
        bundleId: plistString(plist, "CFBundleIdentifier"),
        version: plistString(plist, "CFBundleShortVersionString"),
        bundleVersion: plistString(plist, "CFBundleVersion"),
        executable,
    };
    if (!existsSync(info.asarPath)) {
        throw new Error(`${info.asarPath} is missing`);
    }

    return info;
}

export function defaultCodexDesktopApp(): string {
    const candidates = ["/Applications/ChatGPT.app", join(homedir(), "Applications", "ChatGPT.app")];
    for (const candidate of candidates) {
        const plist = join(candidate, "Contents", "Info.plist");
        const asar = join(candidate, "Contents", "Resources", "app.asar");
        if (!existsSync(plist) || !existsSync(asar)) {
            continue;
        }

        const info = readDesktopApp(candidate);
        if (info.bundleId === CODEX_DESKTOP_BUNDLE_ID) {
            return info.appPath;
        }
    }

    throw new Error(
        "Codex desktop was not found. On macOS it is ChatGPT.app (bundle id com.openai.codex). Pass --app <path>."
    );
}

/** Replace the ElectronAsarIntegrity hash in place. Both hashes are 64 hex characters. */
export function replaceAsarIntegrityHash(plist: string, previousHash: string, nextHash: string): string {
    if (!HASH.test(previousHash) || !HASH.test(nextHash)) {
        throw new Error("asar integrity hashes must be 64 hex characters");
    }

    const occurrences = plist.split(previousHash).length - 1;
    if (occurrences !== 1) {
        throw new Error(
            occurrences === 0
                ? "Info.plist does not contain the current asar integrity hash"
                : `integrity hash appears ${occurrences} times in Info.plist`
        );
    }

    return plist.replace(previousHash, nextHash);
}

export function codexDesktopIsRunning(appPath: string): boolean {
    const result = Bun.spawnSync(["ps", "-axww", "-o", "command="], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
        throw new Error(`ps failed: ${result.stderr.toString()}`);
    }

    return result.stdout.toString().includes(`${join(appPath, "Contents", "MacOS")}/`);
}

export interface BackupMeta {
    version: string;
    bundleVersion: string;
    bundleId: string;
    appPath: string;
    headerHash: string;
    executable: string;
    backedUpAt: string;
}

/**
 * One backup per installed copy and build: the version, the bundle build and a short hash of the
 * app path. Two copies of one release (`--app`) or a rebuild with the same version never share a
 * snapshot, so a revert always restores the bundle it was taken from.
 */
export function backupDirFor(root: string, app: Pick<DesktopAppInfo, "appPath" | "version" | "bundleVersion">): string {
    const where = createHash("sha256").update(app.appPath).digest("hex").slice(0, 8);

    return join(root, `${app.version}-${app.bundleVersion}-${where}`);
}

/** True when the backup was taken from exactly this app copy, build and ASAR header. */
export function backupMatches(backup: BackupMeta, app: DesktopAppInfo, headerHash: string): boolean {
    return (
        backup.appPath === app.appPath &&
        backup.version === app.version &&
        backup.bundleVersion === app.bundleVersion &&
        backup.headerHash === headerHash
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function backupString(record: Record<string, unknown>, key: string, path: string): string {
    const value = record[key];
    if (typeof value !== "string") {
        throw new Error(`${path} is missing ${key}`);
    }

    return value;
}

export function readBackupMeta(dir: string): BackupMeta | null {
    const path = join(dir, "meta.json");
    if (!existsSync(path)) {
        return null;
    }

    const parsed = SafeJSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) {
        throw new Error(`${path} is not a backup manifest`);
    }

    return {
        version: backupString(parsed, "version", path),
        bundleVersion: backupString(parsed, "bundleVersion", path),
        bundleId: backupString(parsed, "bundleId", path),
        appPath: backupString(parsed, "appPath", path),
        headerHash: backupString(parsed, "headerHash", path),
        executable: backupString(parsed, "executable", path),
        backedUpAt: backupString(parsed, "backedUpAt", path),
    };
}

function assertSignaturePieces(app: DesktopAppInfo): void {
    for (const path of [app.executablePath, app.codeResourcesPath, app.plistPath, app.asarPath]) {
        if (!existsSync(path) || !statSync(path).isFile()) {
            throw new Error(`${path} is not a file, so the original signature cannot be restored`);
        }
    }
}

function copyTree(source: string, dest: string): void {
    mkdirSync(dest, { recursive: true });
    const flags = process.platform === "darwin" ? "-cR" : "-R";
    runChecked(["cp", flags, `${source}/.`, `${dest}/`]);
}

export function writeOriginalBackup(app: DesktopAppInfo, dir: string, headerHash: string, backedUpAt: string): void {
    assertSignaturePieces(app);
    mkdirSync(dir, { recursive: true });
    // APFS clones: the backup shares blocks with the installed app until the patch rewrites them, so it
    // costs no space up front (a plain copy of app.asar alone was 480 MB). Elsewhere it falls back to a copy.
    copyFileSync(app.asarPath, join(dir, "app.asar"), fsConstants.COPYFILE_FICLONE);
    copyFileSync(app.plistPath, join(dir, "Info.plist"), fsConstants.COPYFILE_FICLONE);
    copyFileSync(app.codeResourcesPath, join(dir, "CodeResources"), fsConstants.COPYFILE_FICLONE);
    copyFileSync(app.executablePath, join(dir, "executable"), fsConstants.COPYFILE_FICLONE);
    copyTree(app.appPath, join(dir, "app"));
    const meta: BackupMeta = {
        version: app.version,
        bundleVersion: app.bundleVersion,
        bundleId: app.bundleId,
        appPath: app.appPath,
        headerHash,
        executable: app.executable,
        backedUpAt,
    };
    writeFileSync(join(dir, "meta.json"), `${SafeJSON.stringify(meta, null, 2)}\n`);
}

/**
 * Removes the backups of other versions of the same app. A backup restores only its own version, so
 * once the app updated it is dead weight, and its clone no longer shares blocks with anything: about
 * 1.5 GB per old version. Backups of another app path (a second install) are kept.
 */
export function pruneOtherVersionBackups({
    root,
    keepVersion,
    appPath,
}: {
    root: string;
    keepVersion: string;
    appPath: string;
}): string[] {
    if (!existsSync(root)) {
        return [];
    }

    const removed: string[] = [];

    // Entry types without following links: a dangling symlink in the root is skipped, never a throw.
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const name = entry.name;
        const dir = join(root, name);

        if (name === keepVersion || !entry.isDirectory()) {
            continue;
        }

        let meta: BackupMeta | null;
        try {
            meta = readBackupMeta(dir);
        } catch (err) {
            log.debug({ err, dir }, "backup prune: unreadable manifest, kept");
            continue;
        }

        if (!meta || meta.appPath !== appPath || meta.version === keepVersion) {
            continue;
        }

        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
        log.info({ dir, version: meta.version, keepVersion }, "removed the backup of an older Codex desktop version");
    }

    return removed;
}

export function restoreOriginalBackup(app: DesktopAppInfo, dir: string): void {
    const meta = readBackupMeta(dir);
    if (!meta) {
        throw new Error(`No original backup in ${dir}`);
    }

    if (meta.appPath !== app.appPath || meta.version !== app.version || meta.executable !== app.executable) {
        throw new Error(`Backup in ${dir} is for ${meta.appPath} ${meta.version}, not ${app.appPath} ${app.version}`);
    }

    const snapshot = join(dir, "app");
    if (existsSync(join(snapshot, "Contents", "Info.plist"))) {
        copyTree(snapshot, app.appPath);
        return;
    }

    copyFileSync(join(dir, "app.asar"), app.asarPath);
    copyFileSync(join(dir, "Info.plist"), app.plistPath);
    copyFileSync(join(dir, "CodeResources"), app.codeResourcesPath);
    copyFileSync(join(dir, "executable"), app.executablePath);
}

const { log } = logger.scoped("codex-desktop");

function runChecked(args: string[]): void {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
        const detail = result.stderr.toString() || result.stdout.toString();
        throw new Error(`${args.join(" ")} failed: ${detail}`);
    }
}

const DROPPED_ENTITLEMENTS = [
    "com.apple.application-identifier",
    "com.apple.developer.aps-environment",
    "com.apple.developer.team-identifier",
    "com.apple.security.application-groups",
    "keychain-access-groups",
];

/** Drop team-bound entitlements. An ad-hoc or personal signature that still names OpenAI's team is rejected at launch. */
export function launchableEntitlements(plist: string): string {
    let next = plist;
    for (const key of DROPPED_ENTITLEMENTS) {
        const nested = new RegExp(`\\s*<key>${key}</key>\\s*<(array|dict)>[\\s\\S]*?</\\1>`);
        const scalar = new RegExp(
            `\\s*<key>${key}</key>\\s*<(true|false)/>|\\s*<key>${key}</key>\\s*<string>[^<]*</string>`
        );
        next = next.replace(nested, "").replace(scalar, "");
    }

    if (!next.includes("com.apple.security.cs.disable-library-validation")) {
        next = next.replace(
            "</dict>",
            "\t<key>com.apple.security.cs.disable-library-validation</key>\n\t<true/>\n</dict>"
        );
    }

    return next;
}

export function developerIdFromFindIdentity(text: string): string | undefined {
    const match = /([0-9A-F]{40}) "Developer ID Application:/.exec(text);

    return match?.[1];
}

/** `-` is always an ad-hoc signature; `auto` picks the first Developer ID identity, else ad-hoc. */
function signingIdentity(requested: string): { identity: string; runtime: boolean } {
    if (requested === "-") {
        return { identity: "-", runtime: false };
    }

    if (requested !== "auto") {
        return { identity: requested, runtime: true };
    }

    const found = Bun.spawnSync(["security", "find-identity", "-v", "-p", "codesigning"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const developerId = developerIdFromFindIdentity(found.stdout.toString());
    if (developerId) {
        return { identity: developerId, runtime: true };
    }

    return { identity: "-", runtime: false };
}

export function signDesktopApp(appPath: string, identity: string): void {
    const dumped = Bun.spawnSync(["codesign", "-d", "--entitlements", ":-", "--xml", appPath], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const chosen = signingIdentity(identity);
    // --deep re-signs helpers with the same team. The renderer maps the framework
    // and refuses it when the two signatures name different teams.
    const args = ["codesign", "--force", "--deep", "--sign", chosen.identity, "--timestamp=none"];
    if (chosen.runtime) {
        args.push("--options", "runtime");
    }

    const dumpedText = dumped.stdout.toString();
    const xmlAt = dumpedText.indexOf("<?xml");
    const entitlements = xmlAt >= 0 ? dumpedText.slice(xmlAt) : "";
    if (entitlements.includes("<plist")) {
        const entPath = join(tmpdir(), `codex-desktop-entitlements-${process.pid}.plist`);
        writeFileSync(entPath, launchableEntitlements(entitlements));
        args.push("--entitlements", entPath);
    } else {
        log.warn({ appPath, stderr: dumped.stderr.toString() }, "signing without entitlements");
    }

    args.push(appPath);
    log.debug({ appPath, identity: chosen.identity, runtime: chosen.runtime }, "signing Codex desktop");
    runChecked(args);
    runChecked(["codesign", "--verify", "--strict", appPath]);
}

export function verifyDesktopSignature(appPath: string): void {
    try {
        runChecked(["codesign", "--verify", "--strict", appPath]);
    } catch (err) {
        log.warn({ err, appPath }, "restored desktop bundle did not verify");
        throw err;
    }
}
