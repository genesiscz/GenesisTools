import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { LIVE_FACTS } from "@genesiscz/utils/genesis-tools/capability/facts";
import { SafeJSON } from "@genesiscz/utils/json";
import { buildPidRecord, serializePidRecord } from "@genesiscz/utils/process/pidfile";
import { skip } from "@genesiscz/utils/test/skip";
import {
    launcherConfigArgs,
    launcherConfigFlag,
    launcherConfigForSavedCommand,
    savedLauncherConfigIsStale,
} from "../bun/launcher-config";
import { shellCommandLine } from "../shell/quote";
import {
    describeResponsibleIdentity,
    GENESIS_APP_BUNDLE_ID,
    genesisAppLauncher,
    installedAppAccepts,
    isRunningUnderGenesisApp,
    openGenesisAppWindow,
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
    runningWidgetRoot,
    widgetLockPaths,
    writeNativeInboxStateFile,
} from "./native-inbox";

it("opening the permissions window in a test returns the engine refusal without starting the app", async () => {
    const platform = spyOn(LIVE_FACTS, "platform").mockReturnValue("darwin");
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
        throw new Error("unexpected app launch");
    });
    try {
        const outcome = await openGenesisAppWindow();
        expect(outcome).toMatchObject({
            status: "unreachable",
            skipped: [{
                way: "native",
                code: "in-test",
                reason: "app.installed: a test process never reaches GenesisTools.app",
                fix: null,
            }],
        });
        expect(spawn).not.toHaveBeenCalled();
    } finally {
        spawn.mockRestore();
        platform.mockRestore();
    }
});

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
            {
                GENESIS_TOOLS_APP_BUNDLE_ID: undefined,
                GENESIS_TOOLS_NO_APP: undefined,
                GENESIS_TOOLS_HOME: home,
                GENESIS_TOOLS_APP_HOME: home,
            },
            () => {
                expect(genesisAppLauncher()).toBeNull();
            }
        );
    });

    it("returns null when no bundle is installed in the app home", async () => {
        await env.testing.withOverrides(
            {
                GENESIS_TOOLS_APP_BUNDLE_ID: undefined,
                GENESIS_TOOLS_NO_APP: undefined,
                GENESIS_TOOLS_HOME: "/nonexistent",
                GENESIS_TOOLS_APP_HOME: "/nonexistent",
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
                GENESIS_TOOLS_APP_HOME: home,
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
                GENESIS_TOOLS_APP_HOME: home,
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
                GENESIS_TOOLS_APP_HOME: home,
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
                GENESIS_TOOLS_APP_HOME: home,
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
                GENESIS_TOOLS_APP_HOME: home,
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

    it("selects the live widget data root, including Preview and explicit roots", async () => {
        const home = mkdtempSync(join(tmpdir(), "widget-root-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home, GENESIS_TOOLS_APP_HOME: home }, () => {
            const [normal, preview] = widgetLockPaths();
            const live = new Set([preview]);
            const deps = {
                platform: "darwin",
                exists: (path: string) => live.has(path),
                liveWidgetLock: (path: string) => live.has(path),
            };
            expect(runningWidgetRoot({ deps })).toBe(dirname(preview));
            expect(runningWidgetRoot({ root: dirname(normal), deps })).toBeUndefined();
            live.add(normal);
            expect(runningWidgetRoot({ deps })).toBe(dirname(normal));
            expect(runningWidgetRoot({ root: dirname(preview), deps })).toBe(dirname(preview));
            live.clear();
            expect(runningWidgetRoot({ deps })).toBeUndefined();
        });
    });

    it("reads the bundles, the staging key and the widget locks of this home", async () => {
        const home = mkdtempSync(join(tmpdir(), "native-inbox-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home, GENESIS_TOOLS_APP_HOME: home }, () => {
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
        const watcher = Bun.spawn(
            [process.execPath, "-e", "console.log('ready'); setTimeout(() => {}, 30000)", "widget", "watch"],
            { env: process.env, stdout: "pipe", stderr: "ignore" }
        );

        try {
            // Linux runs a child's exec after the spawn returns; until then the child shows this test's command line.
            await watcher.stdout.getReader().read();
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
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home, GENESIS_TOOLS_APP_HOME: home }, () => {
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

// 2026-11-18 00:24: a worktree's build without the `--config=` rule replaced the install, and every `tools` start
// from the main checkout could only be allowed once. Callers now ask the installed build's manifest first.
describe("what the installed app accepts", () => {
    async function withManifest(manifest: object | string | undefined, run: () => void): Promise<void> {
        const home = mkdtempSync(join(tmpdir(), "gt-app-accepts-"));

        if (manifest) {
            mkdirSync(join(home, ".genesis-tools", "app"), { recursive: true });
            writeFileSync(
                join(home, ".genesis-tools", "app", "manifest.json"),
                typeof manifest === "string" ? manifest : SafeJSON.stringify(manifest)
            );
        }

        // The manifest sits beside the installed bundle in the app home; a GENESIS_TOOLS_HOME sandbox does not move it.
        const sandbox = mkdtempSync(join(tmpdir(), "gt-app-accepts-sandbox-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_APP_HOME: home, GENESIS_TOOLS_HOME: sandbox }, run);
    }

    const saved = shellCommandLine(["/opt/bun", launcherConfigFlag(), "run", "/repo/poll daemon.ts"]);

    it("an older build gets no --config=, from a direct start or a saved daemon command", async () => {
        await withManifest({ builtAt: "2026-11-17T23:24:33Z", parts: ["hub"] }, () => {
            expect(installedAppAccepts("launcher-config")).toBe(false);
            expect(launcherConfigArgs()).toEqual([]);
            expect(launcherConfigForSavedCommand(saved)).toBe(
                shellCommandLine(["/opt/bun", "run", "/repo/poll daemon.ts"])
            );
        });
    });

    it("a build that accepts it, or no build at all, keeps the flag", async () => {
        await withManifest({ accepts: ["launcher-config"] }, () => {
            expect(installedAppAccepts("launcher-config")).toBe(true);
            expect(launcherConfigArgs()).toEqual([launcherConfigFlag()]);
            expect(launcherConfigForSavedCommand(saved)).toBe(saved);
        });

        await withManifest(undefined, () => {
            expect(installedAppAccepts("launcher-config")).toBeUndefined();
            expect(launcherConfigArgs()).toEqual([launcherConfigFlag()]);
        });
    });

    it("an installed build whose manifest cannot be read is treated as an older one", async () => {
        await withManifest("{ not json", () => {
            expect(installedAppAccepts("launcher-config")).toBe(false);
            expect(launcherConfigArgs()).toEqual([]);
        });
    });

    it("a saved command loses only the whole flag word, never the same text inside another argument", async () => {
        const printed = `printf '%s\\n' 'keep ${launcherConfigFlag()} unchanged'`;
        const windowsFlag = launcherConfigFlag("C:\\repo\\src\\utils\\bun\\launcher.bunfig.toml");
        const windows = shellCommandLine(["C:\\bun.exe", windowsFlag, "run", "poll.ts"]);

        await withManifest({ parts: ["hub"] }, () => {
            expect(launcherConfigForSavedCommand(printed)).toBe(printed);
            expect(launcherConfigForSavedCommand(windows)).toBe(shellCommandLine(["C:\\bun.exe", "run", "poll.ts"]));
            expect(launcherConfigForSavedCommand(`/opt/bun ${launcherConfigFlag()} run x.ts`)).toBe(
                "/opt/bun run x.ts"
            );
        });
    });

    it("a launchd plist is stale when its flag disagrees with the installed build", async () => {
        const withFlag = `<string>/opt/bun</string><string>${launcherConfigFlag()}</string><string>run</string>`;
        const without = "<string>/opt/bun</string><string>run</string>";

        await withManifest({ parts: ["hub"] }, () => {
            expect(savedLauncherConfigIsStale(withFlag)).toBe(true);
            expect(savedLauncherConfigIsStale(without)).toBe(false);
        });
        await withManifest({ accepts: ["launcher-config"] }, () => {
            expect(savedLauncherConfigIsStale(withFlag)).toBe(false);
            expect(savedLauncherConfigIsStale(without)).toBe(true);
        });
        await withManifest(undefined, () => {
            expect(savedLauncherConfigIsStale(without)).toBe(false);
        });
    });
});
