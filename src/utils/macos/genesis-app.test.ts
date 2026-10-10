import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { buildPidRecord, serializePidRecord } from "@genesiscz/utils/process/pidfile";
import { skip } from "@genesiscz/utils/test/skip";
import {
    describeResponsibleIdentity,
    GENESIS_APP_BUNDLE_ID,
    genesisAppLauncher,
    isRunningUnderGenesisApp,
    responsibleIdentity,
    wrapWithGenesisApp,
} from "./genesis-app";
import {
    inboxStateFromSignals,
    isLiveWidgetLock,
    isWidgetWatchCommand,
    nativeInboxRecord,
    nativeInboxState,
    nativeInboxStateFile,
    widgetLockPaths,
    writeNativeInboxStateFile,
} from "./native-inbox";

describe("responsibleIdentity", () => {
    it("reports GenesisTools.app when the launcher marker is set", async () => {
        await env.testing.withOverrides({ GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID }, () => {
            expect(isRunningUnderGenesisApp()).toBe(true);
            expect(responsibleIdentity()).toEqual({ kind: "genesis-app", bundleId: GENESIS_APP_BUNDLE_ID });
            expect(describeResponsibleIdentity()).toContain("GenesisTools.app");
        });
    });

    it("falls back to the launching app's bundle id", async () => {
        await env.testing.withOverrides(
            { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, __CFBundleIdentifier: "com.example.terminal" },
            () => {
                expect(responsibleIdentity()).toEqual({ kind: "host-app", bundleId: "com.example.terminal" });
                expect(describeResponsibleIdentity()).toContain("com.example.terminal");
            }
        );
    });

    it("says unknown without any bundle in the environment", async () => {
        await env.testing.withOverrides(
            { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, __CFBundleIdentifier: undefined },
            () => {
                expect(responsibleIdentity()).toEqual({ kind: "unknown" });
            }
        );
    });
});

describe("genesisAppLauncher", () => {
    it("never wraps a process that already runs under GenesisTools.app", async () => {
        await env.testing.withOverrides({ GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID }, () => {
            expect(genesisAppLauncher()).toBeNull();
            expect(wrapWithGenesisApp(["bun", "x"])).toEqual(["bun", "x"]);
        });
    });

    it("honours GENESIS_TOOLS_NO_APP=1", async () => {
        await env.testing.withOverrides({ GENESIS_TOOLS_APP_BUNDLE_ID: undefined, GENESIS_TOOLS_NO_APP: "1" }, () => {
            expect(genesisAppLauncher()).toBeNull();
        });
    });

    it("honours the disabled marker written by the settings window", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-home-"));
        const launcher = join(home, "Applications", "GenesisTools.app", "Contents", "MacOS");
        mkdirSync(launcher, { recursive: true });
        writeFileSync(join(launcher, "GenesisTools"), "");
        mkdirSync(join(home, ".genesis-tools", "app"), { recursive: true });
        writeFileSync(join(home, ".genesis-tools", "app", "disabled"), "");
        await env.testing.withOverrides(
            { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, GENESIS_TOOLS_NO_APP: undefined, GENESIS_TOOLS_HOME: home },
            () => {
                expect(genesisAppLauncher()).toBeNull();
            }
        );
    });

    it("returns null when no bundle is installed under GENESIS_TOOLS_HOME", async () => {
        await env.testing.withOverrides(
            {
                GENESIS_TOOLS_APP_BUNDLE_ID: undefined,
                GENESIS_TOOLS_NO_APP: undefined,
                GENESIS_TOOLS_HOME: "/nonexistent",
            },
            () => {
                expect(genesisAppLauncher()).toBeNull();
            }
        );
    });
});

// The wrapper's choice for a `tools` started by an app face (Sources/App/FaceMarker.swift sets the
// markers only when the face's responsible process is GenesisTools) versus a terminal or launchd.
describe.skipIf(skip.unlessMac)("genesisAppLauncher decides per caller", () => {
    function fakeInstall(): { home: string; launcher: string; inode: string } {
        const home = mkdtempSync(join(tmpdir(), "gt-home-"));
        const dir = join(home, "Applications", "GenesisTools.app", "Contents", "MacOS");
        mkdirSync(dir, { recursive: true });
        const launcher = join(dir, "GenesisTools");
        writeFileSync(launcher, "");
        return { home, launcher, inode: String(statSync(launcher).ino) };
    }

    const base = { GENESIS_TOOLS_NO_APP: undefined };

    it("skips both launcher stages under a face marked with the installed launcher's inode", async () => {
        const { home, inode } = fakeInstall();
        await env.testing.withOverrides(
            {
                ...base,
                GENESIS_TOOLS_HOME: home,
                GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID,
                GENESIS_TOOLS_APP_INODE: inode,
            },
            () => {
                expect(genesisAppLauncher()).toBeNull();
            }
        );
    });

    it("uses the launcher from a terminal or launchd job, which carries no marker", async () => {
        const { home, launcher } = fakeInstall();
        await env.testing.withOverrides(
            {
                ...base,
                GENESIS_TOOLS_HOME: home,
                GENESIS_TOOLS_APP_BUNDLE_ID: undefined,
                GENESIS_TOOLS_APP_INODE: undefined,
            },
            () => {
                expect(genesisAppLauncher()).toBe(launcher);
            }
        );
    });

    it("re-enters the launcher when the marked binary was replaced by a rebuild", async () => {
        const { home, launcher, inode } = fakeInstall();
        await env.testing.withOverrides(
            {
                ...base,
                GENESIS_TOOLS_HOME: home,
                GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID,
                GENESIS_TOOLS_APP_INODE: `${inode}9`,
            },
            () => {
                expect(genesisAppLauncher()).toBe(launcher);
            }
        );
    });

    it("re-enters the launcher when only the bundle id is set (a launcher too old to record the inode)", async () => {
        const { home, launcher } = fakeInstall();
        await env.testing.withOverrides(
            {
                ...base,
                GENESIS_TOOLS_HOME: home,
                GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID,
                GENESIS_TOOLS_APP_INODE: undefined,
            },
            () => {
                expect(genesisAppLauncher()).toBe(launcher);
            }
        );
    });

    it("uses the launcher when another app's id is in the marker", async () => {
        const { home, launcher, inode } = fakeInstall();
        await env.testing.withOverrides(
            {
                ...base,
                GENESIS_TOOLS_HOME: home,
                GENESIS_TOOLS_APP_BUNDLE_ID: "com.example.other",
                GENESIS_TOOLS_APP_INODE: inode,
            },
            () => {
                expect(genesisAppLauncher()).toBe(launcher);
            }
        );
    });
});

describe("nativeInboxState", () => {
    const off = { platform: true, previewBundle: false, appBundle: false, stagingFaces: false, widgetRunning: false };

    it("maps the signals: Preview bundle or staged normal app is installed, a live widget lock is running", () => {
        expect(inboxStateFromSignals(off)).toBe("none");
        expect(inboxStateFromSignals({ ...off, appBundle: true })).toBe("none");
        expect(inboxStateFromSignals({ ...off, appBundle: true, stagingFaces: true })).toBe("installed");
        expect(inboxStateFromSignals({ ...off, previewBundle: true })).toBe("installed");
        expect(inboxStateFromSignals({ ...off, previewBundle: true, widgetRunning: true })).toBe("running");
        // A lock without an install (a dev build run by hand) is not a native inbox, and neither is another OS.
        expect(inboxStateFromSignals({ ...off, widgetRunning: true })).toBe("none");
        expect(inboxStateFromSignals({ ...off, platform: false, previewBundle: true, widgetRunning: true })).toBe(
            "none"
        );
    });

    it("reads the bundles, the staging key and the widget locks of this home", async () => {
        const home = mkdtempSync(join(tmpdir(), "native-inbox-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const [lock] = widgetLockPaths();
            const live = new Set<string>();
            const deps = {
                platform: "darwin",
                liveWidgetLock: (path: string) => live.has(path),
                readStagingMarker: () => true,
            };

            expect(nativeInboxState({ deps })).toBe("none");
            expect(nativeInboxState({ deps: { ...deps, platform: "linux" } })).toBe("none");

            mkdirSync(join(home, "Applications", "GenesisTools.app"), { recursive: true });
            expect(nativeInboxState({ deps })).toBe("installed");
            expect(nativeInboxState({ deps: { ...deps, readStagingMarker: () => false } })).toBe("none");

            mkdirSync(join(home, "Applications", "GenesisTools Preview.app"), { recursive: true });
            // The Preview bundle is an install on its own, whatever the staging key says.
            const previewOnly = { ...deps, readStagingMarker: () => false };
            expect(nativeInboxState({ deps: previewOnly })).toBe("installed");

            // A live verdict for a lock file that does not exist never counts.
            live.add(lock!);
            expect(nativeInboxState({ deps: previewOnly })).toBe("installed");
            mkdirSync(join(lock!, ".."), { recursive: true });
            writeFileSync(lock!, "{}");
            expect(nativeInboxState({ deps: previewOnly })).toBe("running");
            live.clear();
            expect(nativeInboxState({ deps: previewOnly })).toBe("installed");
        });
    });

    it("a lock counts only while its pid still runs the widget watcher it recorded", async () => {
        expect(isWidgetWatchCommand("bun /repo/src/hub/index.ts widget watch --stop-on-stdin")).toBe(true);
        expect(
            isWidgetWatchCommand("bun /repo/src/hub/index.ts widget --state-root /home/.genesis-tools/data watch")
        ).toBe(true);
        expect(isWidgetWatchCommand("bun /repo/src/hub/index.ts widget snapshot --json")).toBe(false);
        expect(isWidgetWatchCommand("bun /repo/src/watch/index.ts watchwidget")).toBe(false);
        const dir = mkdtempSync(join(tmpdir(), "native-inbox-lock-"));
        const lock = join(dir, "worker.lock");
        const watcher = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)", "widget", "watch"], {
            env: process.env,
            stdout: "ignore",
            stderr: "ignore",
        });

        try {
            writeFileSync(lock, serializePidRecord(buildPidRecord(watcher.pid)));
            expect(isWidgetWatchCommand(buildPidRecord(watcher.pid).command)).toBe(true);
            expect(isLiveWidgetLock(lock)).toBe(true);

            // This test process is alive, but it is not the program a widget lock names.
            writeFileSync(lock, serializePidRecord(buildPidRecord(process.pid)));
            expect(isLiveWidgetLock(lock)).toBe(false);

            // A recycled pid: the record names the watcher, the pid now runs something else.
            writeFileSync(
                lock,
                SafeJSON.stringify({ ...buildPidRecord(process.pid), command: "bun src/hub/index.ts widget watch" })
            );
            expect(isLiveWidgetLock(lock)).toBe(false);
        } finally {
            watcher.kill();
            await watcher.exited;
        }

        writeFileSync(lock, serializePidRecord({ ...buildPidRecord(process.pid), pid: watcher.pid }));
        expect(isLiveWidgetLock(lock)).toBe(false);
    });

    it("writes the hooks' state file only for a native install, and rewrites it when the install goes away", async () => {
        const home = mkdtempSync(join(tmpdir(), "native-inbox-file-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            const path = nativeInboxStateFile();
            const none = nativeInboxRecord({ ...off });
            const installed = nativeInboxRecord({ ...off, previewBundle: true });

            expect(writeNativeInboxStateFile(none, path)).toBe(false);
            expect(existsSync(path)).toBe(false);
            expect(writeNativeInboxStateFile(installed, path)).toBe(true);
            expect(SafeJSON.parse(readFileSync(path, "utf8"))).toEqual({
                version: 1,
                installed: true,
                bundles: [join(home, "Applications", "GenesisTools Preview.app")],
                widgetLocks: widgetLockPaths(),
            });
            expect(writeNativeInboxStateFile(installed, path)).toBe(false);
            expect(writeNativeInboxStateFile(none, path)).toBe(true);
            expect(SafeJSON.parse(readFileSync(path, "utf8")).installed).toBe(false);
        });
    });
});
