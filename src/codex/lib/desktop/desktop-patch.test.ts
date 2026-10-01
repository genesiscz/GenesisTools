import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

import {
    backupDirFor,
    developerIdFromFindIdentity,
    launchableEntitlements,
    pruneOtherVersionBackups,
    readBackupMeta,
    readDesktopApp,
} from "./app-bundle";
import { applyDesktopPatch, inspectDesktop, revertDesktopPatch } from "./apply";
import {
    fileIntegrity,
    missingAsarNeedles,
    openAsar,
    packAsar,
    readAsarFile,
    rewriteAsar,
    writeAsarFile,
} from "./asar";
import { injectDesktopPatchLinks } from "./html";
import {
    INTEGRITY_DICTIONARY_SENTINEL,
    integrityDictionaryDigest,
    locateIntegrityDigestBinary,
} from "./integrity-digest";
import { toolOutputCss, toolOutputScript } from "./patches/tool-output";

const INDEX = `<!doctype html>
<html>
  <head>
    <style>
      #root {
        width: 100%;
      }
    </style>
    <script type="module" crossorigin src="./assets/index.js"></script>
  </head>
</html>
`;

function plist(hash: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>ChatGPT</string>
  <key>CFBundleIdentifier</key><string>com.openai.codex</string>
  <key>CFBundleShortVersionString</key><string>1.2.3</string>
  <key>CFBundleVersion</key><string>9</string>
  <key>ElectronAsarIntegrity</key><dict>
    <key>Resources/app.asar</key><dict>
      <key>algorithm</key><string>SHA256</string>
      <key>hash</key><string>${hash}</string>
    </dict>
  </dict>
</dict></plist>
`;
}

function makeApp(root: string): { appPath: string; backupRoot: string } {
    const appPath = join(root, "ChatGPT.app");
    const resources = join(appPath, "Contents", "Resources");
    mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appPath, "Contents", "_CodeSignature"), { recursive: true });
    mkdirSync(resources, { recursive: true });
    const asarPath = join(resources, "app.asar");
    const packed = packAsar(asarPath, {
        "webview/index.html": INDEX,
        "webview/markers.txt": "vertical-scroll-fade-mask\nline-clamp-2\n",
    });
    writeFileSync(join(appPath, "Contents", "Info.plist"), plist(packed.headerHash));
    writeFileSync(join(appPath, "Contents", "MacOS", "ChatGPT"), "signed-binary");
    writeFileSync(join(appPath, "Contents", "_CodeSignature", "CodeResources"), "sealed");
    const framework = join(appPath, "Contents", "Frameworks", "Codex Framework.framework", "Versions", "Current");
    mkdirSync(join(framework, "Resources"), { recursive: true });
    writeFileSync(
        join(framework, "Resources", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Codex Framework</string>
</dict></plist>
`
    );
    const slot = Buffer.alloc(80);
    Buffer.from(INTEGRITY_DICTIONARY_SENTINEL).copy(slot, 4);
    slot[36] = 1;
    slot[37] = 1;
    integrityDictionaryDigest([{ path: "Resources/app.asar", algorithm: "SHA256", hash: packed.headerHash }]).copy(
        slot,
        38
    );
    writeFileSync(join(framework, "Codex Framework"), slot);

    // The app is read by its canonical path (the temp dir sits behind /var -> /private/var).
    return { appPath: realpathSync(appPath), backupRoot: join(root, "backup") };
}

function deps(running = false) {
    const signed: string[] = [];
    const verified: string[] = [];

    return {
        signed,
        verified,
        deps: {
            now: () => "2026-09-30T00:00:00.000Z",
            running: () => running,
            sign: (appPath: string) => {
                signed.push(appPath);
            },
            verify: (appPath: string) => {
                verified.push(appPath);
            },
        },
    };
}

describe("launchable signature", () => {
    test("drops another team's entitlements and keeps library validation off", () => {
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>2DC432GLL2.com.openai.codex</string>
<key>com.apple.developer.team-identifier</key><string>2DC432GLL2</string>
<key>com.apple.security.application-groups</key><array><string>2DC432GLL2.com.openai.codex.notifications</string></array>
<key>keychain-access-groups</key><array><string>2DC432GLL2.*</string></array>
<key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>`;
        const next = launchableEntitlements(plist);
        expect(next).not.toContain("2DC432GLL2");
        expect(next).toContain("com.apple.security.cs.allow-jit");
        expect(next).toContain("com.apple.security.cs.disable-library-validation");
        expect(
            developerIdFromFindIdentity(
                '  3) 00B19497EBBEEB0723ECDE42FD6312677BEF2A29 "Developer ID Application: Example (VUGCA6N5S8)"'
            )
        ).toBe("00B19497EBBEEB0723ECDE42FD6312677BEF2A29");
    });

    test("seals the integrity dictionary the way Electron reads it", () => {
        const digest = integrityDictionaryDigest([
            {
                path: "Resources/app.asar",
                algorithm: "SHA256",
                hash: "cdfebc59f4a32f4202b12bc26bbc0ff6875fec9491eb2254a5fc0b75eae48d2e",
            },
        ]);
        expect(digest.toString("hex")).toBe("0f8538ec9f471984725fdf0f8a172b730176a44f8b2da515c2c7a4ff6a144028");
    });
});

describe("desktop asar", () => {
    test("round-trips replaced and added files with electron's integrity hash", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-asar-"));
        const asarPath = join(root, "app.asar");
        packAsar(asarPath, { "a.txt": "hello", "dir/b.txt": "world" });
        const archive = openAsar(asarPath);
        expect(readAsarFile(archive, "a.txt").toString()).toBe("hello");
        writeAsarFile(archive, "a.txt", "hello!");
        writeAsarFile(archive, "dir/c.txt", "added");
        const next = join(root, "next.asar");
        const rewritten = rewriteAsar(archive, next);
        const opened = openAsar(next);
        expect(opened.headerHash).toBe(rewritten.headerHash);
        expect(readAsarFile(opened, "a.txt").toString()).toBe("hello!");
        expect(readAsarFile(opened, "dir/b.txt").toString()).toBe("world");
        expect(readAsarFile(opened, "dir/c.txt").toString()).toBe("added");
        const hello = Buffer.from("hello!");
        expect(fileIntegrity(hello).hash).toBe(createHash("sha256").update(hello).digest("hex"));
        const big = Buffer.alloc(4 * 1024 * 1024 + 3, 7);
        const integrity = fileIntegrity(big);
        expect(integrity.blocks).toHaveLength(2);
        expect(integrity.hash).toBe(createHash("sha256").update(big).digest("hex"));
    });

    test("finds a needle that crosses a read boundary", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-needle-"));
        const file = join(root, "blob");
        writeFileSync(file, "aaaaVERTICAL-scroll");
        expect(missingAsarNeedles(file, ["aVERTICAL"], 4)).toEqual([]);
        expect(missingAsarNeedles(file, ["missing"], 4)).toEqual(["missing"]);
    });
});

describe("tool output patch", () => {
    test("css keeps the escaped command class and the script parses", () => {
        expect(toolOutputCss()).toContain("vertical-scroll-fade-mask");
        expect(toolOutputCss()).toContain(".group\\/command");
        expect(toolOutputCss()).toContain("var(--gt-tool-output-max-height)");
        const script = toolOutputScript();
        expect(script).toContain("Tool output height");
        expect(script).toContain("Auto-expand grouped tool calls");
        expect(script).toContain('button[data-d-component="pressable"][data-d-direction="row"][aria-label]');
        expect(script).toContain(".lucide-chevron-down");
        expect(script).toContain('"value":"full"');
        expect(script).not.toContain("patchRevision");
        expect(() => new Function(script)).not.toThrow();
    });

    test("html injection is idempotent and refuses an unknown layout", () => {
        const once = injectDesktopPatchLinks(INDEX);
        const twice = injectDesktopPatchLinks(once);
        expect(once.match(/genesis-tools-desktop-patch/g)?.length).toBe(2);
        expect(twice).toBe(once);
        expect(() => injectDesktopPatchLinks("<html></html>")).toThrow(/unknown webview layout/);
    });
});

describe("apply and revert", () => {
    test("confirmation does not write, apply is idempotent, and revert restores the header", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-desktop-"));
        const { appPath, backupRoot } = makeApp(root);
        const harness = deps();
        const input = {
            appPath,
            backupRoot,
            enabledIds: ["tool-outputs"],
            signIdentity: "-",
            yes: false,
        };
        const preview = applyDesktopPatch(input, harness.deps);
        expect(preview.kind).toBe("needs-confirmation");
        expect(readBackupMeta(backupDirFor(backupRoot, readDesktopApp(appPath)))).toBeNull();

        const before = inspectDesktop(appPath, backupRoot, harness.deps);
        const applied = applyDesktopPatch({ ...input, yes: true }, harness.deps);
        expect(applied.kind).toBe("applied");
        if (applied.kind !== "applied") {
            return;
        }

        expect(applied.status.patched).toBe(true);
        expect(applied.status.manifest?.patches[0]?.id).toBe("tool-outputs");
        expect(applied.status.headerHash).not.toBe(before.headerHash);
        expect(readFileSync(locateIntegrityDigestBinary(appPath)).subarray(38, 70).toString("hex")).toEqual(
            integrityDictionaryDigest([
                { path: "Resources/app.asar", algorithm: "SHA256", hash: applied.status.headerHash },
            ]).toString("hex")
        );
        expect(harness.signed).toEqual([appPath]);
        const html = readAsarFile(openAsar(applied.status.app.asarPath), "webview/index.html").toString();
        expect(html.match(/genesis-tools-desktop\.css/g)?.length).toBe(1);
        const script = readAsarFile(
            openAsar(applied.status.app.asarPath),
            "webview/genesis-tools-desktop.js"
        ).toString();
        expect(script).toContain("Tool output height");

        const again = applyDesktopPatch({ ...input, yes: true }, harness.deps);
        expect(again.kind).toBe("unchanged");
        expect(harness.signed).toHaveLength(1);
        const htmlAgain = readAsarFile(openAsar(applied.status.app.asarPath), "webview/index.html").toString();
        expect(htmlAgain.match(/genesis-tools-desktop\.css/g)?.length).toBe(1);

        const turnedOff = applyDesktopPatch({ ...input, yes: true, enabledIds: [] }, harness.deps);
        expect(turnedOff.kind).toBe("reverted");
        expect(inspectDesktop(appPath, backupRoot, harness.deps).patched).toBe(false);

        const restored = applyDesktopPatch({ ...input, yes: true }, harness.deps);
        expect(restored.kind).toBe("applied");
        const reverted = revertDesktopPatch({ appPath, backupRoot, yes: true }, harness.deps);
        expect(reverted.kind).toBe("reverted");
        expect(harness.verified.length).toBeGreaterThan(0);
        const after = inspectDesktop(appPath, backupRoot, harness.deps);
        expect(after.patched).toBe(false);
        expect(after.headerHash).toBe(before.headerHash);
        expect(readFileSync(join(appPath, "Contents", "Info.plist"), "utf8")).toContain(before.headerHash);
        expect(readFileSync(locateIntegrityDigestBinary(appPath)).subarray(38, 70).toString("hex")).toEqual(
            integrityDictionaryDigest([
                { path: "Resources/app.asar", algorithm: "SHA256", hash: before.headerHash },
            ]).toString("hex")
        );
    });

    test("a changed patch script is written again for the same patch id", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-desktop-refresh-"));
        const { appPath, backupRoot } = makeApp(root);
        const harness = deps();
        const input = {
            appPath,
            backupRoot,
            enabledIds: ["tool-outputs"],
            signIdentity: "-",
            yes: true,
        };
        const applied = applyDesktopPatch(input, harness.deps);
        expect(applied.kind).toBe("applied");
        if (applied.kind !== "applied") {
            return;
        }

        const archive = openAsar(applied.status.app.asarPath);
        writeAsarFile(archive, "webview/genesis-tools-desktop.js", "stale\n");
        const stale = join(root, "stale.asar");
        const rewritten = rewriteAsar(archive, stale);
        const plistPath = join(appPath, "Contents", "Info.plist");
        writeFileSync(
            plistPath,
            readFileSync(plistPath, "utf8").replaceAll(applied.status.headerHash, rewritten.headerHash)
        );
        copyFileSync(stale, applied.status.app.asarPath);

        const refreshed = applyDesktopPatch(input, harness.deps);
        expect(refreshed.kind).toBe("applied");
        const script = readAsarFile(
            openAsar(applied.status.app.asarPath),
            "webview/genesis-tools-desktop.js"
        ).toString();
        expect(script).toContain("Auto-expand grouped tool calls");
        expect(harness.signed).toEqual([appPath, appPath]);
    });

    test("a running app and a missing anchor write nothing", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-desktop-skip-"));
        const { appPath, backupRoot } = makeApp(root);
        const preview = applyDesktopPatch(
            {
                appPath,
                backupRoot,
                enabledIds: ["tool-outputs"],
                signIdentity: "-",
                yes: false,
            },
            deps(true).deps
        );
        expect(preview.kind).toBe("needs-confirmation");
        expect(() =>
            applyDesktopPatch(
                {
                    appPath,
                    backupRoot,
                    enabledIds: ["tool-outputs"],
                    signIdentity: "-",
                    yes: true,
                },
                deps(true).deps
            )
        ).toThrow(/Quit Codex desktop/);
        expect(readBackupMeta(backupDirFor(backupRoot, readDesktopApp(appPath)))).toBeNull();

        const bare = mkdtempSync(join(tmpdir(), "codex-desktop-bare-"));
        const bareApp = makeApp(bare);
        const asarPath = join(bareApp.appPath, "Contents", "Resources", "app.asar");
        const packed = packAsar(asarPath, { "webview/index.html": "<html></html>" });
        writeFileSync(join(bareApp.appPath, "Contents", "Info.plist"), plist(packed.headerHash));
        expect(() =>
            applyDesktopPatch(
                {
                    appPath: bareApp.appPath,
                    backupRoot: bareApp.backupRoot,
                    enabledIds: ["tool-outputs"],
                    signIdentity: "-",
                    yes: true,
                },
                deps().deps
            )
        ).toThrow(/missing vertical-scroll-fade-mask|unknown webview layout/);
        expect(readBackupMeta(backupDirFor(bareApp.backupRoot, readDesktopApp(bareApp.appPath)))).toBeNull();
    });

    test("an app that starts while the patch is prepared is left untouched", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-desktop-race-"));
        const { appPath, backupRoot } = makeApp(root);
        const before = inspectDesktop(appPath, backupRoot, deps().deps);
        let checks = 0;
        expect(() =>
            applyDesktopPatch(
                {
                    appPath,
                    backupRoot,
                    enabledIds: ["tool-outputs"],
                    signIdentity: "-",
                    yes: true,
                },
                {
                    ...deps().deps,
                    // Stopped at the status read, running at the mutation.
                    running: () => checks++ > 0,
                }
            )
        ).toThrow(/started while the patch was prepared/);
        const after = inspectDesktop(appPath, backupRoot, deps().deps);
        expect(after.headerHash).toBe(before.headerHash);
        expect(after.patched).toBe(false);
        expect(existsSync(join(backupRoot, ".lock"))).toBe(false);
    });

    test("a lock with no pid yet is held; a dead owner's lock is reported, never taken over", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-desktop-lock-"));
        const { appPath, backupRoot } = makeApp(root);
        mkdirSync(backupRoot, { recursive: true });
        const input = { appPath, backupRoot, enabledIds: ["tool-outputs"], signIdentity: "-", yes: true };

        writeFileSync(join(backupRoot, ".lock"), "");
        expect(() => applyDesktopPatch(input, deps().deps)).toThrow(/Another Codex desktop patch is running/);

        writeFileSync(join(backupRoot, ".lock"), "999999999");
        expect(() => applyDesktopPatch(input, deps().deps)).toThrow(/no longer running/);
        expect(readFileSync(join(backupRoot, ".lock"), "utf8")).toBe("999999999");
    });

    test("two copies of one release keep separate backups", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-desktop-copies-"));
        const first = makeApp(join(root, "a"));
        const second = makeApp(join(root, "b"));
        expect(backupDirFor(first.backupRoot, readDesktopApp(first.appPath))).not.toBe(
            backupDirFor(first.backupRoot, readDesktopApp(second.appPath))
        );
    });

    test("a failed signature restores the original header", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-desktop-sign-"));
        const { appPath, backupRoot } = makeApp(root);
        const before = inspectDesktop(appPath, backupRoot, deps().deps);
        expect(() =>
            applyDesktopPatch(
                {
                    appPath,
                    backupRoot,
                    enabledIds: ["tool-outputs"],
                    signIdentity: "-",
                    yes: true,
                },
                {
                    now: () => "2026-09-30T00:00:00.000Z",
                    running: () => false,
                    sign: () => {
                        throw new Error("sign refused");
                    },
                }
            )
        ).toThrow(/sign refused/);
        const after = inspectDesktop(appPath, backupRoot, deps().deps);
        expect(after.headerHash).toBe(before.headerHash);
        expect(after.patched).toBe(false);
    });
});

describe("pruneOtherVersionBackups", () => {
    function backup(root: string, version: string, appPath: string): string {
        const dir = join(root, version);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "meta.json"),
            `${SafeJSON.stringify({ version, bundleVersion: "1", bundleId: "com.openai.codex", appPath, headerHash: "a".repeat(64), executable: "Codex", backedUpAt: "2026-09-30T00:00:00Z" })}\n`
        );
        return dir;
    }

    test("removes older versions of the same app and keeps the current one and other installs", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-desktop-prune-"));
        const old = backup(root, "1.0.0", "/Applications/Codex.app");
        const current = backup(root, "2.0.0", "/Applications/Codex.app");
        const other = backup(root, "1.5.0", "/Users/alice/Applications/Codex.app");
        mkdirSync(join(root, "stray"));

        const removed = pruneOtherVersionBackups({ root, keepVersion: "2.0.0", appPath: "/Applications/Codex.app" });

        expect(removed).toEqual([old]);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(current)).toBe(true);
        expect(existsSync(other)).toBe(true);
        expect(existsSync(join(root, "stray"))).toBe(true);
    });
});
