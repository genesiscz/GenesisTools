import { describe, expect, test } from "bun:test";
import type { TccRow } from "@app/macos/lib/permissions/tcc";
import { fitColumnWidths } from "./output-format";
import {
    type AxLivePermissions,
    buildChecks,
    capabilityRoutes,
    collectFindings,
    collectProblems,
    type ResponsibleRoute,
    refineRoute,
} from "./permissions";

const APP = "com.genesiscz.genesistools";

const routed: ResponsibleRoute = {
    launcher: "/fixture/GenesisTools.app/Contents/MacOS/GenesisTools",
    routed: true,
    identity: `GenesisTools.app (${APP})`,
    bundleId: APP,
    holder: { bundleId: APP, viaGenesisApp: true },
};

const unrouted: ResponsibleRoute = {
    launcher: null,
    routed: false,
    identity: "the terminal or host app (com.example.terminal)",
    bundleId: "com.example.terminal",
    reason: "GENESIS_TOOLS_NO_APP=1 is set",
    cause: "env",
    holder: { bundleId: "com.example.terminal", viaGenesisApp: false },
};

/** A fresh Mac: GenesisTools.app was never built, and nothing switched the launcher off. */
const appMissing: ResponsibleRoute = {
    launcher: null,
    routed: false,
    identity: "the terminal or host app (com.apple.Terminal)",
    bundleId: "com.apple.Terminal",
    reason: "GenesisTools.app is not installed",
    cause: "missing",
    holder: { bundleId: "com.apple.Terminal", viaGenesisApp: false },
};

const noRows = { readable: true, rows: [] };

function live(overrides: Partial<AxLivePermissions> = {}): AxLivePermissions {
    return {
        accessibility: true,
        screenRecording: true,
        viaGenesisApp: true,
        responsiblePid: 4242,
        responsibleBundleId: APP,
        responsiblePath: "/fixture/GenesisTools.app/Contents/MacOS/GenesisTools",
        ...overrides,
    };
}

const TERMINAL = "com.apple.Terminal";

/** What ax-tool reports when Terminal.app holds the grants: the A1 case from #447. */
function terminalProbe(overrides: Partial<AxLivePermissions> = {}): AxLivePermissions {
    return live({
        viaGenesisApp: false,
        responsiblePid: 1940,
        responsibleBundleId: TERMINAL,
        responsiblePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
        responsibleName: "Terminal",
        ...overrides,
    });
}

function row(service: string, client: string, authValue: number, target?: string): TccRow {
    return {
        service,
        client,
        clientType: 0,
        authValue,
        target,
        label: authValue === 2 ? "allowed" : "denied",
        lastModified: "2026-09-16T00:00:00.000Z",
    };
}

const fullSystem = {
    readable: true,
    rows: [row("kTCCServiceAccessibility", APP, 2), row("kTCCServiceScreenCapture", APP, 2)],
};
const fullUser = { readable: true, rows: [row("kTCCServiceAppleEvents", APP, 2, "com.apple.systemevents")] };

describe("buildChecks", () => {
    test("every grant held by GenesisTools.app reads as granted from the live probe", () => {
        const checks = buildChecks({ route: routed, live: live(), system: fullSystem, user: fullUser });

        expect(checks.map((c) => [c.id, c.status])).toEqual([
            ["accessibility", "granted"],
            ["screen-recording", "granted"],
            ["automation", "granted"],
        ]);
        expect(checks.every((c) => c.identity === `GenesisTools.app (${APP})`)).toBe(true);
        expect(checks[0].pane).toBe("System Settings > Privacy & Security > Accessibility");
        expect(checks[1].openCommand).toBe("tools macos permissions open --pane screen-recording");
        expect(checks[2].targets).toEqual([{ target: "com.apple.systemevents", granted: true, label: "allowed" }]);
    });

    test("the live probe wins over TCC.db, and the mismatch is spelled out", () => {
        const checks = buildChecks({
            route: routed,
            live: live({ accessibility: false }),
            system: fullSystem,
            user: fullUser,
        });

        expect(checks[0].status).toBe("denied");
        expect(checks[0].detail).toContain("did not run as that identity");
        expect(checks[1].status).toBe("granted");
    });

    test("no TCC row and a negative live probe is not-determined, never denied", () => {
        const checks = buildChecks({
            route: routed,
            live: live({ accessibility: false, screenRecording: false }),
            system: { readable: true, rows: [] },
            user: { readable: true, rows: [] },
        });

        expect(checks.map((c) => c.status)).toEqual(["not-determined", "not-determined", "not-determined"]);
    });

    test("without a live probe the verdict comes from TCC.db and says so", () => {
        const checks = buildChecks({
            route: routed,
            live: null,
            system: { readable: true, rows: [row("kTCCServiceAccessibility", APP, 0)] },
            user: { readable: false, rows: [] },
        });

        expect(checks[0].status).toBe("denied");
        expect(checks[0].source).toContain("live probe failed");
        expect(checks[1].status).toBe("not-determined");
        expect(checks[2].status).toBe("unknown");
    });

    // Regression test: #447 — plain see/act refuse without Screen Recording, yet USED BY listed only "see --path"
    test("the Screen Recording check lists see and act among the commands that need it", () => {
        const checks = buildChecks({ route: routed, live: live(), system: fullSystem, user: fullUser });
        const usedBy = checks[1].usedBy.split(", ");

        expect(usedBy).toContain("see");
        expect(usedBy).toContain("act");
    });

    // Regression test: #447 — the audit's capability table carried the same "see --path" claim
    test("the native Screen Recording route lists see and act among its commands", () => {
        const commands = capabilityRoutes(routed)[1].commands.split(", ");

        expect(commands).toContain("see");
        expect(commands).toContain("act");
    });

    test("Automation is never probed live: it is read from TCC.db per target", () => {
        const checks = buildChecks({
            route: routed,
            live: live(),
            system: fullSystem,
            user: {
                readable: true,
                rows: [
                    row("kTCCServiceAppleEvents", APP, 2, "com.apple.systemevents"),
                    row("kTCCServiceAppleEvents", APP, 0, "com.apple.Notes"),
                ],
            },
        });

        expect(checks[2].status).toBe("granted");
        expect(checks[2].source).toContain("TCC.db only");
        expect(checks[2].detail).toContain("1 of 2 target apps allowed");
    });
});

describe("collectProblems", () => {
    test("a fully granted, routed setup has no problems", () => {
        const checks = buildChecks({ route: routed, live: live(), system: fullSystem, user: fullUser });
        expect(collectProblems({ route: routed, checks, live: live() })).toEqual([]);
    });

    test("an unrouted run is a problem even when the terminal happens to hold the grants", () => {
        const terminal = "com.example.terminal";
        const checks = buildChecks({
            route: unrouted,
            live: live(),
            system: {
                readable: true,
                rows: [row("kTCCServiceAccessibility", terminal, 2), row("kTCCServiceScreenCapture", terminal, 2)],
            },
            user: { readable: true, rows: [row("kTCCServiceAppleEvents", terminal, 2, "com.apple.systemevents")] },
        });
        const problems = collectProblems({ route: unrouted, checks, live: live() });

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("run unwrapped");
        expect(problems[0]).toContain("GENESIS_TOOLS_NO_APP=1 is set");
    });

    test("a missing grant names the pane, the open command and GenesisTools", () => {
        const checks = buildChecks({
            route: routed,
            live: live({ screenRecording: false }),
            system: fullSystem,
            user: fullUser,
        });
        const problems = collectProblems({ route: routed, checks, live: live({ screenRecording: false }) });

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("Screen Recording is denied");
        expect(problems[0]).toContain("tools macos permissions open --pane screen-recording");
        expect(problems[0]).toContain("turn on GenesisTools");
    });

    // Regression test: #447 — with no GenesisTools.app on the Mac, every line said "tick GenesisTools"
    test("without GenesisTools.app a missing grant is turned on for the responsible app", () => {
        const probe = terminalProbe({ accessibility: false });
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });
        const accessibility = collectProblems({ route, checks, live: probe }).find((p) =>
            p.startsWith("Accessibility")
        );

        expect(accessibility).toContain("turn on Terminal");
        expect(accessibility).not.toContain("tick GenesisTools");
    });

    // Regression test: #447 — "Fix: unset GENESIS_TOOLS_NO_APP" was offered on Macs where it was never set
    test("an unrouted run offers to unset GENESIS_TOOLS_NO_APP only when that variable is the cause", () => {
        const probe = terminalProbe();
        const missing = refineRoute(appMissing, probe);
        const fromEnv = refineRoute(unrouted, probe);
        const checks = buildChecks({ route: missing, live: probe, system: noRows, user: noRows });

        expect(collectProblems({ route: missing, checks, live: probe })[0]).not.toContain("GENESIS_TOOLS_NO_APP");
        expect(collectProblems({ route: fromEnv, checks, live: probe })[0]).toContain("unset GENESIS_TOOLS_NO_APP");
    });

    // Regression test: #447 — the unrouted line read "not GenesisTools.app instead of GenesisTools.app"
    test("without GenesisTools.app the unrouted line names the responsible app and how to fix it", () => {
        const probe = terminalProbe();
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });
        const unwrapped = collectProblems({ route, checks, live: probe })[0];

        expect(unwrapped).toContain("their grants follow Terminal (com.apple.Terminal), pid 1940.");
        expect(unwrapped).toContain("turn the grants below on for Terminal");
    });

    // Regression test: #447 — "denied" got the same advice as "never asked", though macOS will not ask again
    test("a denied grant says macOS will not ask again and how to clear the decision", () => {
        const probe = terminalProbe({ accessibility: false });
        const route = refineRoute(appMissing, probe);
        const system = { readable: true, rows: [row("kTCCServiceAccessibility", TERMINAL, 0)] };
        const checks = buildChecks({ route, live: probe, system, user: noRows });
        const accessibility = collectProblems({ route, checks, live: probe }).find((p) =>
            p.startsWith("Accessibility")
        );

        expect(accessibility).toContain("macOS will not ask again");
        expect(accessibility).toContain("`tccutil reset Accessibility com.apple.Terminal`");
    });

    // Regression test: #447 — the tccutil service name differs from the pane name for Screen Recording
    test("a denied Screen Recording grant is reset under the ScreenCapture service", () => {
        const probe = terminalProbe({ screenRecording: false });
        const route = refineRoute(appMissing, probe);
        const system = { readable: true, rows: [row("kTCCServiceScreenCapture", TERMINAL, 0)] };
        const checks = buildChecks({ route, live: probe, system, user: noRows });
        const screen = collectProblems({ route, checks, live: probe }).find((p) => p.startsWith("Screen Recording"));

        expect(screen).toContain("`tccutil reset ScreenCapture com.apple.Terminal`");
    });

    // Regression test: #447 — a never-asked host is not in the list yet, so there is nothing to switch on
    test("a never-asked grant says to add the app with + and offers no reset", () => {
        const probe = terminalProbe({ accessibility: false });
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });
        const accessibility = collectProblems({ route, checks, live: probe }).find((p) =>
            p.startsWith("Accessibility")
        );

        expect(accessibility).toContain("add it with + if it is not listed");
        expect(accessibility).not.toContain("tccutil");
    });

    // Regression test: #447 — tccutil resets by bundle id, so a bundle-less host must not get a reset it cannot run
    test("a denied grant for a host without a bundle id offers no tccutil reset", () => {
        const probe = terminalProbe({
            accessibility: false,
            responsibleBundleId: "",
            responsibleName: "",
            responsiblePath: "/opt/fixture/bin/agent",
        });
        const route = refineRoute(appMissing, probe);
        const system = { readable: true, rows: [row("kTCCServiceAccessibility", "/opt/fixture/bin/agent", 0)] };
        const checks = buildChecks({ route, live: probe, system, user: noRows });
        const accessibility = collectProblems({ route, checks, live: probe }).find((p) =>
            p.startsWith("Accessibility")
        );

        expect(accessibility).toContain("macOS will not ask again");
        expect(accessibility).not.toContain("tccutil");
    });

    // Regression test: #447 — Automation has no pane entry until an Apple event asks, so "turn on" sent users hunting
    test("a never-asked Automation grant says macOS asks on the first osascript run", () => {
        const probe = terminalProbe();
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });
        const automation = collectProblems({ route, checks, live: probe }).find((p) => p.startsWith("Automation"));

        expect(automation).toContain("macOS asks once per target app the first time osascript drives it");
    });

    // Regression test: #447 — a launcher switched off by marker got the GENESIS_TOOLS_NO_APP advice
    test("a launcher switched off by its marker is fixed with `tools macos permissions enable`", () => {
        const probe = terminalProbe();
        const route = refineRoute({ ...appMissing, cause: "marker", reason: "the launcher is switched off" }, probe);
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });

        const unwrapped = collectProblems({ route, checks, live: probe })[0];

        expect(unwrapped).toContain("Fix: `tools macos permissions enable`");
        expect(unwrapped).not.toContain("GENESIS_TOOLS_NO_APP");
    });

    // Regression test: #447 / #445 — on a Command Line Tools-only Mac, "build GenesisTools.app" ends in 133 Swift errors
    test("with only the Command Line Tools, the build advice says to install Xcode first", () => {
        const probe = terminalProbe();
        const route = refineRoute(
            {
                ...appMissing,
                toolchain: { kind: "command-line-tools", developerDir: "/Library/Developer/CommandLineTools" },
            },
            probe
        );
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });

        expect(collectProblems({ route, checks, live: probe })[0]).toContain("install Xcode");
    });

    test("a launcher that macOS did not hold responsible is reported, not hidden", () => {
        const probe = live({ viaGenesisApp: false, responsibleBundleId: "", responsiblePath: "/usr/local/bin/bun" });
        const checks = buildChecks({ route: routed, live: probe, system: fullSystem, user: fullUser });
        const problems = collectProblems({ route: routed, checks, live: probe });

        expect(problems.some((p) => p.includes("held pid 4242 (/usr/local/bin/bun) responsible"))).toBe(true);
    });
});

describe("fitColumnWidths (doctor and audit tables)", () => {
    // GRANT, STATUS, IDENTITY, USED BY, SOURCE; 222 characters of content plus 16 of borders and padding.
    const natural = [16, 16, 60, 60, 70];
    const sourceThenUsedByThenIdentity = [4, 3, 2];

    // Regression test: #447 — IDENTITY was cut at 48 characters in a terminal wide enough for all of it
    test("a terminal wide enough for every value cuts nothing", () => {
        expect(fitColumnWidths({ natural, available: 250, shrinkOrder: sourceThenUsedByThenIdentity })).toEqual(
            natural
        );
    });

    test("a narrow terminal cuts SOURCE, then USED BY, and keeps IDENTITY whole while it can", () => {
        expect(fitColumnWidths({ natural, available: 150, shrinkOrder: sourceThenUsedByThenIdentity })).toEqual([
            16, 16, 60, 30, 12,
        ]);
    });

    test("output without a terminal width, a pipe or a file, is never cut", () => {
        expect(fitColumnWidths({ natural, available: undefined, shrinkOrder: sourceThenUsedByThenIdentity })).toEqual(
            natural
        );
    });
});

describe("capabilityRoutes", () => {
    // Regression test: #447 — audit said "spawned through the GenesisTools.app launcher" on a Mac with no launcher
    test("without the launcher, no route claims to be spawned through it", () => {
        const notes = capabilityRoutes(refineRoute(appMissing, terminalProbe())).map((r) => r.note);

        expect(notes.filter((note) => /spawned through the (GenesisTools\.app )?launcher/.test(note))).toEqual([]);
        expect(notes[0]).toContain("spawned directly, without the GenesisTools.app launcher");
    });

    test("with the launcher, the Accessibility route says it is spawned through it", () => {
        expect(capabilityRoutes(routed)[0].note).toContain("spawned through the GenesisTools.app launcher");
    });
});

describe("collectFindings", () => {
    function hostAt(path: string): ResponsibleRoute {
        return refineRoute(
            appMissing,
            live({ viaGenesisApp: false, responsiblePid: 2172, responsibleBundleId: "", responsiblePath: path })
        );
    }

    // Regression test: #447 — a grant given to Claude Code's …/2.1.286/f2326db61802/… binary dies with the next update
    test("a responsible app in a versioned folder warns that the next update drops its grants", () => {
        const route = hostAt(
            "/Users/someone/Library/Application Support/Host/agent/2.1.286/f2326db61802/agent.app/Contents/MacOS/agent"
        );
        const findings = collectFindings(route);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toContain("2.1.286");
        expect(findings[0]).toContain("the next agent update drops every grant given to it");
        expect(findings[0]).toContain("GenesisTools.app");
    });

    // Regression test: #447 — version folders also come with a leading v (nvm, some Electron installers)
    test("a v-prefixed version folder counts as versioned", () => {
        expect(collectFindings(hostAt("/Users/someone/.nvm/versions/node/v26.10.0/bin/node"))).toHaveLength(1);
    });

    test("an app at a fixed path gets no versioned-folder warning", () => {
        expect(collectFindings(refineRoute(appMissing, terminalProbe()))).toEqual([]);
    });
});

describe("refineRoute", () => {
    test("a routed run keeps the launcher identity", () => {
        expect(refineRoute(routed, live())).toBe(routed);
    });

    test("an unrouted run takes the identity from the probe, not from __CFBundleIdentifier", () => {
        const refined = refineRoute(
            unrouted,
            live({ viaGenesisApp: false, responsibleBundleId: "", responsiblePath: "/usr/local/bin/bun" })
        );

        expect(refined.identity).toBe("bun (/usr/local/bin/bun), pid 4242");
        expect(refined.bundleId).toBe("/usr/local/bin/bun");
        expect(refined.routed).toBe(false);
    });

    // Regression test: #447 — the identity named only "pid 1940 (com.apple.Terminal)", never the app to turn on
    test("an unrouted run names the responsible app in plain words, then its bundle id and pid", () => {
        const refined = refineRoute(unrouted, terminalProbe());

        expect(refined.identity).toBe("Terminal (com.apple.Terminal), pid 1940");
    });

    // Regression test: #447 — a bundle-less host was shown as a bare binary path deep inside its .app
    test("a host without a bundle id is named after its .app folder", () => {
        const refined = refineRoute(
            unrouted,
            live({
                viaGenesisApp: false,
                responsiblePid: 2172,
                responsibleBundleId: "",
                responsiblePath:
                    "/Users/someone/Library/Application Support/Host/9.1.0/abc123/host.app/Contents/MacOS/host",
            })
        );

        expect(refined.identity).toBe(
            "host (/Users/someone/Library/Application Support/Host/9.1.0/abc123/host.app), pid 2172"
        );
    });

    // Regression test: #447 — NO_APP inside a GenesisTools.app session claimed "not GenesisTools.app" while the probe said it was
    test("a probe that ran under GenesisTools.app is named GenesisTools.app even without the launcher", () => {
        const refined = refineRoute(unrouted, live({ responsiblePid: 33 }));

        expect(refined.identity).toBe(`GenesisTools.app (${APP}), pid 33`);
    });
});
