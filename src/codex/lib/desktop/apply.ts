import {
    closeSync,
    copyFileSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";

import {
    backupDirFor,
    backupMatches,
    codexDesktopIsRunning,
    readBackupMeta,
    readDesktopApp,
    replaceAsarIntegrityHash,
    restoreOriginalBackup,
    signDesktopApp,
    verifyDesktopSignature,
    writeOriginalBackup,
} from "./app-bundle";
import { missingAsarNeedles, openAsar, readAsarFile, rewriteAsar, writeAsarFile } from "./asar";
import { injectDesktopPatchLinks } from "./html";
import {
    electronAsarIntegrityEntries,
    integrityDictionaryDigest,
    locateIntegrityDigestBinary,
    writeIntegrityDictionaryDigest,
} from "./integrity-digest";
import { desktopPatch } from "./registry";
import type { DesktopPatchManifest, DesktopPatchSelection, DesktopStatus } from "./types";

const INDEX = "webview/index.html";
const STYLESHEET = "webview/genesis-tools-desktop.css";
const SCRIPT = "webview/genesis-tools-desktop.js";
const MANIFEST = "webview/genesis-tools-desktop.json";

const { log } = logger.scoped("codex-desktop");

export interface DesktopPatchDeps {
    now?: () => string;
    running?: (appPath: string) => boolean;
    sign?: (appPath: string, identity: string) => void;
    verify?: (appPath: string) => void;
}

export interface ApplyDesktopPatchInput {
    appPath: string;
    backupRoot: string;
    /** The patches that should be on after this call. An empty list restores the original app. */
    enabledIds: string[];
    signIdentity: string;
    yes: boolean;
}

export interface RevertDesktopPatchInput {
    appPath: string;
    backupRoot: string;
    yes: boolean;
}

export type ApplyDesktopPatchResult =
    | { kind: "needs-confirmation"; status: DesktopStatus }
    | { kind: "unchanged"; status: DesktopStatus }
    | { kind: "applied"; status: DesktopStatus }
    | { kind: "reverted"; status: DesktopStatus };

export type RevertDesktopPatchResult =
    | { kind: "needs-confirmation"; status: DesktopStatus }
    | { kind: "already-original"; status: DesktopStatus }
    | { kind: "reverted"; status: DesktopStatus };

interface ReadyDeps {
    now: () => string;
    running: (appPath: string) => boolean;
    sign: (appPath: string, identity: string) => void;
    verify: (appPath: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ready(deps: DesktopPatchDeps): ReadyDeps {
    return {
        now: deps.now ?? (() => new Date().toISOString()),
        running: deps.running ?? codexDesktopIsRunning,
        sign: deps.sign ?? signDesktopApp,
        verify: deps.verify ?? verifyDesktopSignature,
    };
}

function errorCode(err: unknown): string | undefined {
    if (!isRecord(err)) {
        return undefined;
    }

    const code = err.code;
    if (typeof code !== "string") {
        return undefined;
    }

    return code;
}

function readOptionalAsarText(archive: ReturnType<typeof openAsar>, filePath: string): string | null {
    try {
        return readAsarFile(archive, filePath).toString("utf8");
    } catch (err) {
        if (err instanceof Error && err.message.includes("is not in the asar")) {
            return null;
        }

        throw err;
    }
}

function parseManifest(text: string): DesktopPatchManifest {
    const parsed = SafeJSON.parse(text);
    if (!isRecord(parsed) || !Array.isArray(parsed.patches)) {
        throw new Error("desktop patch manifest is invalid");
    }

    if (
        typeof parsed.appliedAt !== "string" ||
        typeof parsed.appVersion !== "string" ||
        typeof parsed.bundleVersion !== "string"
    ) {
        throw new Error("desktop patch manifest is missing fields");
    }

    const patches: DesktopPatchSelection[] = [];
    for (const entry of parsed.patches) {
        if (!isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.options)) {
            throw new Error("desktop patch manifest has a bad patch entry");
        }

        const options: Record<string, string> = {};
        for (const [key, value] of Object.entries(entry.options)) {
            if (typeof value !== "string") {
                throw new Error(`patch option ${key} is not a string`);
            }

            options[key] = value;
        }

        patches.push({ id: entry.id, options });
    }

    return {
        appliedAt: parsed.appliedAt,
        appVersion: parsed.appVersion,
        bundleVersion: parsed.bundleVersion,
        patches,
    };
}

function replaceFile(from: string, to: string): void {
    try {
        renameSync(from, to);
    } catch (err) {
        if (errorCode(err) !== "EXDEV") {
            throw err;
        }

        // Across devices: copy beside the target, then rename there. A failed copy leaves the
        // original in place instead of a half-written file.
        const staged = join(dirname(to), `.${process.pid}.next`);
        copyFileSync(from, staged);
        renameSync(staged, to);
    }
}

/**
 * One apply or revert at a time per backup root: both write the same staging files and the same
 * live bundle. The lock file holds the owner's pid; a lock whose owner is gone is taken over.
 */
function withDesktopLock<T>(backupRoot: string, fn: () => T): T {
    mkdirSync(backupRoot, { recursive: true });
    const lockPath = join(backupRoot, ".lock");
    const fd = acquireDesktopLock(lockPath);

    try {
        writeSync(fd, String(process.pid));
        closeSync(fd);

        return fn();
    } finally {
        // Only our own lock: a lock another process took over after ours went stale stays.
        try {
            if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
                unlinkSync(lockPath);
            }
        } catch (err) {
            log.debug({ err, lockPath }, "codex desktop patch lock was already gone");
        }
    }
}

/**
 * Exclusive create only, so two contenders never both win. A held lock is never removed here, not even
 * a dead owner's: an automatic takeover races (two processes read the same dead pid, one unlinks the
 * lock the other just created). A stale lock is reported with the exact command that removes it.
 */
function acquireDesktopLock(lockPath: string): number {
    try {
        return openSync(lockPath, "wx");
    } catch (err) {
        if (errorCode(err) !== "EEXIST") {
            throw err;
        }
    }

    const text = readFileSync(lockPath, "utf8").trim();
    const owner = Number.parseInt(text, 10);

    if (text === "" || isProcessAlive(owner)) {
        throw new Error(
            `Another Codex desktop patch is running${text ? ` (pid ${text})` : ""}. Wait for it, then retry.`
        );
    }

    log.warn({ lockPath, owner }, "a stale Codex desktop patch lock blocks the patch");
    throw new Error(
        `A Codex desktop patch lock from pid ${owner} (no longer running) is left at ${lockPath}. ` +
            `If no patch is running, remove it (mv "${lockPath}" "${lockPath}.stale") and retry.`
    );
}

function assertNotRunning(resolved: ReadyDeps, appPath: string, message: string): void {
    // Checked again right before the bundle changes: the app may have started since the status read.
    if (resolved.running(appPath)) {
        throw new Error(message);
    }
}

export function inspectDesktop(appPath: string, backupRoot: string, deps: DesktopPatchDeps = {}): DesktopStatus {
    const resolved = ready(deps);
    const app = readDesktopApp(appPath);
    const archive = openAsar(app.asarPath);
    const manifestText = readOptionalAsarText(archive, MANIFEST);
    const manifest = manifestText === null ? null : parseManifest(manifestText);
    const backupDir = backupDirFor(backupRoot, app);
    const backup = readBackupMeta(backupDir);

    return {
        app,
        headerHash: archive.headerHash,
        patched: manifest !== null && manifest.patches.length > 0,
        manifest,
        backupDir: backup ? backupDir : null,
        running: resolved.running(app.appPath),
        asarBytes: statSync(app.asarPath).size,
    };
}

function renderedPayload(enabledIds: readonly string[]): { css: string; script: string } {
    const rendered = enabledIds.map((id) => desktopPatch(id).render({}));

    return {
        css: `${rendered.map((part) => part.css).join("\n")}\n`,
        script: `${rendered.map((part) => part.script).join("\n")}\n`,
    };
}

function patchPayloadMatches(asarPath: string, enabledIds: readonly string[]): boolean {
    const payload = renderedPayload(enabledIds);
    const archive = openAsar(asarPath);

    return (
        readOptionalAsarText(archive, STYLESHEET) === payload.css &&
        readOptionalAsarText(archive, SCRIPT) === payload.script
    );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }

    const wanted = new Set(right);

    return left.every((id) => wanted.has(id));
}

export function applyDesktopPatch(input: ApplyDesktopPatchInput, deps: DesktopPatchDeps = {}): ApplyDesktopPatchResult {
    if (!input.yes) {
        return applyUnlocked(input, deps);
    }

    return withDesktopLock(input.backupRoot, () => applyUnlocked(input, deps));
}

function applyUnlocked(input: ApplyDesktopPatchInput, deps: DesktopPatchDeps): ApplyDesktopPatchResult {
    const resolved = ready(deps);
    const status = inspectDesktop(input.appPath, input.backupRoot, deps);
    const enabledIds = [...new Set(input.enabledIds)];
    for (const id of enabledIds) {
        desktopPatch(id);
    }

    const currentIds = status.manifest?.patches.map((patch) => patch.id) ?? [];
    if (
        sameIds(enabledIds, currentIds) &&
        (enabledIds.length === 0 || patchPayloadMatches(status.app.asarPath, enabledIds))
    ) {
        return { kind: "unchanged", status };
    }

    if (!input.yes) {
        return { kind: "needs-confirmation", status };
    }

    if (status.running) {
        throw new Error("Quit Codex desktop before patching it. A running app keeps the old bundle in memory.");
    }

    if (enabledIds.length === 0) {
        const reverted = revertUnlocked({ appPath: input.appPath, backupRoot: input.backupRoot, yes: true }, deps);
        if (reverted.kind === "already-original") {
            return { kind: "unchanged", status: reverted.status };
        }

        return { kind: "reverted", status: reverted.status };
    }

    const next = enabledIds.map((id) => ({ id, options: {} }));
    const needles = [...new Set(next.flatMap((selection) => [...desktopPatch(selection.id).needles]))];
    const missing = missingAsarNeedles(status.app.asarPath, needles);
    if (missing.length > 0) {
        throw new Error(`This Codex build is missing ${missing.join(", ")}; no patch was applied.`);
    }

    const manifest: DesktopPatchManifest = {
        appliedAt: resolved.now(),
        appVersion: status.app.version,
        bundleVersion: status.app.bundleVersion,
        patches: next,
    };
    const payload = renderedPayload(enabledIds);
    const archive = openAsar(status.app.asarPath);
    const html = readAsarFile(archive, INDEX).toString("utf8");
    writeAsarFile(archive, INDEX, injectDesktopPatchLinks(html));
    writeAsarFile(archive, STYLESHEET, payload.css);
    writeAsarFile(archive, SCRIPT, payload.script);
    writeAsarFile(archive, MANIFEST, `${SafeJSON.stringify(manifest, null, 2)}\n`);

    const dir = backupDirFor(input.backupRoot, status.app);
    const backup = readBackupMeta(dir);
    if (status.patched && !backup) {
        throw new Error(
            "This app is already patched, but the original backup is missing. Reinstall Codex desktop, then apply again."
        );
    }

    if (
        status.patched &&
        backup &&
        (backup.appPath !== status.app.appPath || backup.bundleVersion !== status.app.bundleVersion)
    ) {
        throw new Error(`The backup in ${dir} is not from ${status.app.appPath}; nothing was changed.`);
    }

    if (!status.patched && (!backup || !backupMatches(backup, status.app, status.headerHash))) {
        writeOriginalBackup(status.app, dir, status.headerHash, resolved.now());
        log.debug({ dir, version: status.app.version }, "saved original Codex desktop bundle");
    }

    const nextAsar = join(dir, "next-app.asar");
    const rewritten = rewriteAsar(archive, nextAsar);
    const nextPlist = join(dir, "Info.plist.next");
    const plist = replaceAsarIntegrityHash(
        readFileSync(status.app.plistPath, "utf8"),
        status.headerHash,
        rewritten.headerHash
    );
    writeFileSync(nextPlist, plist);
    const digestBinary = locateIntegrityDigestBinary(status.app.appPath);

    assertNotRunning(
        resolved,
        status.app.appPath,
        "Codex desktop started while the patch was prepared. Quit it, then apply again."
    );

    let mutated = false;
    try {
        replaceFile(nextAsar, status.app.asarPath);
        mutated = true;
        replaceFile(nextPlist, status.app.plistPath);
        writeIntegrityDictionaryDigest(digestBinary, integrityDictionaryDigest(electronAsarIntegrityEntries(plist)));
        resolved.sign(status.app.appPath, input.signIdentity);
    } catch (err) {
        if (mutated) {
            restoreOriginalBackup(status.app, dir);
            log.warn({ err, appPath: status.app.appPath }, "restored Codex desktop after a failed patch");
        }

        throw err;
    }

    log.debug({ appPath: status.app.appPath, enabledIds, headerHash: rewritten.headerHash }, "patched Codex desktop");

    return { kind: "applied", status: inspectDesktop(input.appPath, input.backupRoot, deps) };
}

export function revertDesktopPatch(
    input: RevertDesktopPatchInput,
    deps: DesktopPatchDeps = {}
): RevertDesktopPatchResult {
    if (!input.yes) {
        return revertUnlocked(input, deps);
    }

    return withDesktopLock(input.backupRoot, () => revertUnlocked(input, deps));
}

function revertUnlocked(input: RevertDesktopPatchInput, deps: DesktopPatchDeps): RevertDesktopPatchResult {
    const resolved = ready(deps);
    const status = inspectDesktop(input.appPath, input.backupRoot, deps);
    const dir = backupDirFor(input.backupRoot, status.app);
    const backup = readBackupMeta(dir);
    if (!backup) {
        throw new Error(`No original backup for ${status.app.version}. Nothing was changed.`);
    }

    if (!status.patched && status.headerHash === backup.headerHash) {
        return { kind: "already-original", status };
    }

    if (!input.yes) {
        return { kind: "needs-confirmation", status };
    }

    if (status.running) {
        throw new Error("Quit Codex desktop before restoring it.");
    }

    assertNotRunning(resolved, status.app.appPath, "Quit Codex desktop before restoring it.");
    restoreOriginalBackup(status.app, dir);
    resolved.verify(status.app.appPath);
    log.debug({ appPath: status.app.appPath, version: status.app.version }, "reverted Codex desktop patch");

    return { kind: "reverted", status: inspectDesktop(input.appPath, input.backupRoot, deps) };
}
