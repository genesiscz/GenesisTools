import { describe, expect, test } from "bun:test";
import type { TccRow } from "@app/macos/lib/permissions/tcc";
import { fitColumnWidths } from "./output-format";
import { type PermissionRequestBoundary, type RequestableGrant, requestPermissions } from "./permission-request";
import {
    type AxLivePermissions,
    allGrantedSummary,
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

const commandLineTools = { kind: "command-line-tools", developerDir: "/Library/Developer/CommandLineTools" } as const;

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

/** Terminal.app holding all three grants itself, with no GenesisTools.app on the Mac. */
const terminalSystem = {
    readable: true,
    rows: [row("kTCCServiceAccessibility", TERMINAL, 2), row("kTCCServiceScreenCapture", TERMINAL, 2)],
};
const terminalUser = { readable: true, rows: [row("kTCCServiceAppleEvents", TERMINAL, 2, "com.apple.systemevents")] };

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

    // Regression test: PR #456 review — without Full Disk Access TCC.db is unreadable, which proves no denial
    test("a negative live probe with an unreadable TCC.db is unknown, never denied", () => {
        const checks = buildChecks({
            route: routed,
            live: live({ accessibility: false, screenRecording: false }),
            system: { readable: false, rows: [] },
            user: { readable: false, rows: [] },
        });

        expect(checks[0].status).toBe("unknown");
        expect(checks[1].status).toBe("unknown");
        expect(checks[0].detail).toContain("unknown");
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

    // Regression test: #447 D10 — doctor exited 1 forever on a Mac that cannot build GenesisTools.app, though the host held every grant
    test("an unrouted run whose host holds every grant has no problems", () => {
        const probe = terminalProbe();
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: terminalSystem, user: terminalUser });

        expect(collectProblems({ route, checks, live: probe })).toEqual([]);
    });

    // Regression test: #447 D10 — the launcher being off is a warning that proposes the build, with the Xcode steps
    test("an unrouted run whose host holds every grant is warned, with the build proposal", () => {
        const probe = terminalProbe();
        const route = refineRoute({ ...appMissing, toolchain: commandLineTools }, probe);
        const checks = buildChecks({ route, live: probe, system: terminalSystem, user: terminalUser });
        const [unwrapped] = collectFindings({ route, checks });

        expect(unwrapped).toContain("Terminal (com.apple.Terminal), pid 1940 holds every grant tools control needs");
        expect(unwrapped).toContain("install Xcode");
    });

    test("an unrouted run inside a GenesisTools.app session does not offer GenesisTools.app as an improvement", () => {
        const probe = live({ responsiblePid: 33 });
        const route = refineRoute(unrouted, probe);
        const checks = buildChecks({ route, live: probe, system: fullSystem, user: fullUser });
        const [unwrapped] = collectFindings({ route, checks });

        expect(unwrapped).not.toContain("GenesisTools.app would hold them");
        expect(unwrapped).toContain("unset GENESIS_TOOLS_NO_APP");
    });

    test("an unrouted run with a missing grant still has a problem", () => {
        const probe = terminalProbe({ screenRecording: false });
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: terminalSystem, user: terminalUser });

        expect(collectProblems({ route, checks, live: probe })).toHaveLength(1);
    });

    test("the summary of a clean run names the identity that holds the grants", () => {
        const probe = terminalProbe();

        expect(allGrantedSummary(refineRoute(appMissing, probe))).toBe(
            "every grant tools control needs is held by Terminal (com.apple.Terminal), pid 1940"
        );
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
        const probe = terminalProbe({ screenRecording: false });
        const missing = refineRoute(appMissing, probe);
        const fromEnv = refineRoute(unrouted, probe);
        const checks = buildChecks({ route: missing, live: probe, system: noRows, user: noRows });

        expect(collectFindings({ route: missing, checks })[0]).not.toContain("GENESIS_TOOLS_NO_APP");
        expect(collectFindings({ route: fromEnv, checks })[0]).toContain("unset GENESIS_TOOLS_NO_APP");
    });

    // Regression test: #447 — the unrouted line read "not GenesisTools.app instead of GenesisTools.app"
    test("without GenesisTools.app the unrouted line names the responsible app and how to fix it", () => {
        const probe = terminalProbe({ screenRecording: false });
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });
        const unwrapped = collectFindings({ route, checks })[0];

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

    // Regression test: #447 D2 — the verdict sent users to the pane by hand, though a command can ask macOS
    test("a never-asked grant names `tools control permissions request` before the manual pane", () => {
        const probe = terminalProbe({ accessibility: false });
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });
        const accessibility =
            collectProblems({ route, checks, live: probe }).find((p) => p.startsWith("Accessibility")) ?? "";

        expect(accessibility).toContain("Run `tools control permissions request`");
        expect(accessibility.indexOf("permissions request")).toBeLessThan(accessibility.indexOf("System Settings"));
    });

    test("a denied grant names `tools control permissions request` before the manual pane", () => {
        const probe = terminalProbe({ screenRecording: false });
        const route = refineRoute(appMissing, probe);
        const system = { readable: true, rows: [row("kTCCServiceScreenCapture", TERMINAL, 0)] };
        const checks = buildChecks({ route, live: probe, system, user: noRows });
        const screen =
            collectProblems({ route, checks, live: probe }).find((p) => p.startsWith("Screen Recording")) ?? "";

        expect(screen).toContain("Run `tools control permissions request`");
        expect(screen.indexOf("permissions request")).toBeLessThan(screen.indexOf("System Settings"));
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
        const checks = buildChecks({ route, live: probe, system: terminalSystem, user: noRows });
        const automation = collectFindings({ route, checks }).find((f) => f.startsWith("Automation"));

        expect(automation).toContain("macOS asks once per target app the first time osascript drives it");
    });

    // Regression test: #447 — Automation can only be asked by the first Apple event, so doctor exited 1 on every fresh Mac
    test("a never-asked Automation grant is not a problem when the other grants are held", () => {
        const probe = terminalProbe();
        const route = refineRoute(appMissing, probe);
        const checks = buildChecks({ route, live: probe, system: terminalSystem, user: noRows });

        expect(collectProblems({ route, checks, live: probe })).toEqual([]);
    });

    test("a denied Automation grant is still a problem", () => {
        const probe = terminalProbe();
        const route = refineRoute(appMissing, probe);
        const denied = { readable: true, rows: [row("kTCCServiceAppleEvents", TERMINAL, 0, "com.apple.systemevents")] };
        const checks = buildChecks({ route, live: probe, system: terminalSystem, user: denied });

        expect(collectProblems({ route, checks, live: probe }).some((p) => p.startsWith("Automation"))).toBe(true);
    });

    // Regression test: #447 — a launcher switched off by marker got the GENESIS_TOOLS_NO_APP advice
    test("a launcher switched off by its marker is fixed with `tools macos permissions enable`", () => {
        const probe = terminalProbe({ screenRecording: false });
        const route = refineRoute({ ...appMissing, cause: "marker", reason: "the launcher is switched off" }, probe);
        const checks = buildChecks({ route, live: probe, system: noRows, user: noRows });

        const unwrapped = collectFindings({ route, checks })[0];

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

        expect(collectFindings({ route, checks })[0]).toContain("install Xcode");
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
    function versionedFindings(route: ResponsibleRoute): string[] {
        return collectFindings({ route, checks: [] }).filter((finding) => finding.includes("versioned folder"));
    }

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
        const findings = versionedFindings(route);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toContain("2.1.286");
        expect(findings[0]).toContain("the next agent update drops every grant given to it");
        expect(findings[0]).toContain("GenesisTools.app");
    });

    // Regression test: #447 — version folders also come with a leading v (nvm, some Electron installers)
    test("a v-prefixed version folder counts as versioned", () => {
        expect(versionedFindings(hostAt("/Users/someone/.nvm/versions/node/v26.10.0/bin/node"))).toHaveLength(1);
    });

    test("an app at a fixed path gets no versioned-folder warning", () => {
        expect(versionedFindings(refineRoute(appMissing, terminalProbe()))).toEqual([]);
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

describe("requestPermissions", () => {
    /** The Mac as the request sees it: a probe that turns true after N polls, a clock moved only by sleep. */
    function fakeMac(base: AxLivePermissions, grantAfterPolls: Partial<Record<RequestableGrant, number>> = {}) {
        let clock = 0;
        let polls = 0;
        const prompted: RequestableGrant[] = [];
        const opened: RequestableGrant[] = [];
        const sleeps: number[] = [];
        const lines: string[] = [];
        const boundary: PermissionRequestBoundary = {
            probe: () => {
                polls++;
                return {
                    ...base,
                    accessibility:
                        base.accessibility || polls >= (grantAfterPolls.accessibility ?? Number.POSITIVE_INFINITY),
                    screenRecording:
                        base.screenRecording ||
                        polls >= (grantAfterPolls["screen-recording"] ?? Number.POSITIVE_INFINITY),
                };
            },
            prompt: (grant) => {
                prompted.push(grant);
                return { ok: true };
            },
            openPane: (grant) => {
                opened.push(grant);
            },
            sleep: async (ms, signal) => {
                if (signal.aborted) {
                    throw new Error("aborted");
                }

                sleeps.push(ms);
                clock += ms;
            },
            now: () => clock,
        };
        return {
            boundary,
            prompted,
            opened,
            sleeps,
            lines,
            say: (line: string) => lines.push(line),
            polls: () => polls,
        };
    }

    function terminalChecks(probe: AxLivePermissions, system: { readable: boolean; rows: TccRow[] } = noRows) {
        const route = refineRoute(appMissing, probe);
        return { route, checks: buildChecks({ route, live: probe, system, user: noRows }) };
    }

    // Regression test: #447 D2 — nothing ever asked macOS, so a fresh Terminal was never even listed in the pane
    test("a never-asked grant is prompted, its pane opened, and the request waits until it is live", async () => {
        const probe = terminalProbe({ accessibility: false });
        const { route, checks } = terminalChecks(probe);
        const mac = fakeMac(probe, { accessibility: 3 });

        const outcome = await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
        });

        expect(mac.prompted).toEqual(["accessibility"]);
        expect(mac.opened).toEqual(["accessibility"]);
        expect(outcome).toEqual({ granted: ["accessibility", "screen-recording"], missing: [] });
        expect(mac.sleeps.every((ms) => ms >= 1000)).toBe(true);
    });

    // Regression test: #447 D2 — macOS never asks again after a denial, so a prompt would silently do nothing
    test("a denied grant is not prompted; it says why and gives the tccutil reset", async () => {
        const probe = terminalProbe({ accessibility: false });
        const { route, checks } = terminalChecks(probe, {
            readable: true,
            rows: [row("kTCCServiceAccessibility", TERMINAL, 0)],
        });
        const mac = fakeMac(probe, { accessibility: 2 });

        await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
        });

        expect(mac.prompted).toEqual([]);
        expect(mac.opened).toEqual(["accessibility"]);
        expect(mac.lines.join("\n")).toContain("macOS will not ask again");
        expect(mac.lines.join("\n")).toContain("`tccutil reset Accessibility com.apple.Terminal`");
    });

    // Regression test: PR #456 review — a fresh Mac has no Full Disk Access, so TCC.db is unreadable;
    // only a recorded denial proves macOS will not ask, so an unknown decision is still prompted
    test("a missing grant whose TCC.db row cannot be read is still prompted", async () => {
        const probe = terminalProbe({ accessibility: false });
        const { route, checks } = terminalChecks(probe, { readable: false, rows: [] });
        const mac = fakeMac(probe, { accessibility: 2 });

        await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
        });

        expect(mac.prompted).toEqual(["accessibility"]);
        expect(mac.lines.join("\n")).not.toContain("macOS will not ask again");
    });

    // Regression test: #447 D2 — a new Screen Recording grant applies to the host only after it restarts
    test("a Screen Recording request says the host app must be restarted", async () => {
        const probe = terminalProbe({ screenRecording: false });
        const { route, checks } = terminalChecks(probe);
        const mac = fakeMac(probe, { "screen-recording": 2 });

        await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
        });

        expect(mac.prompted).toEqual(["screen-recording"]);
        expect(mac.lines.join("\n")).toContain("quit and reopen Terminal");
    });

    // Regression test: PR #456 review — a failed request-permission spawn shows no dialog, yet the request said "Asked macOS"
    test("a prompt ax-tool could not deliver is reported, and the pane still opens", async () => {
        const probe = terminalProbe({ accessibility: false });
        const { route, checks } = terminalChecks(probe);
        const mac = fakeMac(probe, { accessibility: 2 });
        mac.boundary.prompt = (grant) => {
            mac.prompted.push(grant);
            return { ok: false, error: "unknown subcommand request-permission" };
        };

        await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
        });

        const text = mac.lines.join("\n");
        expect(text).toContain("could not ask macOS for Accessibility");
        expect(text).toContain("unknown subcommand request-permission");
        expect(text).not.toContain("Asked macOS");
        expect(mac.opened).toEqual(["accessibility"]);
    });

    test("the wait ends at its deadline and names what is still missing", async () => {
        const probe = terminalProbe({ screenRecording: false });
        const { route, checks } = terminalChecks(probe);
        const mac = fakeMac(probe);

        const outcome = await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
            timeoutMs: 120_000,
        });

        expect(outcome).toEqual({ granted: ["accessibility"], missing: ["screen-recording"] });
        expect(mac.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(120_000);
        expect(mac.lines.at(-1)).toContain("Still missing after 120 s: Screen Recording");
    });

    // Regression test: PR #456 review — a grant turned on while the wait was on another one was reported missing
    test("a grant that goes live while the wait is on another one counts, and is not prompted", async () => {
        const probe = terminalProbe({ accessibility: false, screenRecording: false });
        const { route, checks } = terminalChecks(probe);
        const mac = fakeMac(probe, { "screen-recording": 2 });

        const outcome = await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
            timeoutMs: 10_000,
        });

        expect(outcome).toEqual({ granted: ["screen-recording"], missing: ["accessibility"] });
        expect(mac.prompted).toEqual(["accessibility"]);
        expect(mac.lines.join("\n")).toContain("Screen Recording is now granted to Terminal");
    });

    // Regression test: PR #456 review — the second grant shared the first one's deadline, so it got no time at all
    test("each grant gets its own wait, so the second is still polled after the first times out", async () => {
        const probe = terminalProbe({ accessibility: false, screenRecording: false });
        const { route, checks } = terminalChecks(probe);
        const mac = fakeMac(probe, { "screen-recording": 15 });

        const outcome = await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
            timeoutMs: 10_000,
        });

        expect(outcome).toEqual({ granted: ["screen-recording"], missing: ["accessibility"] });
        expect(mac.prompted).toEqual(["accessibility", "screen-recording"]);
        expect(mac.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(15_000);
        expect(mac.lines.at(-1)).toContain("Still missing after 10 s: Accessibility");
    });

    test("Ctrl-C stops the wait and reports what is still missing", async () => {
        const probe = terminalProbe({ accessibility: false });
        const { route, checks } = terminalChecks(probe);
        const mac = fakeMac(probe);
        const interrupt = new AbortController();
        const sleep = mac.boundary.sleep;
        mac.boundary.sleep = async (ms, signal) => {
            if (mac.sleeps.length === 2) {
                interrupt.abort();
            }

            await sleep(ms, signal);
        };

        const outcome = await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: interrupt.signal,
            say: mac.say,
        });

        expect(outcome.missing).toEqual(["accessibility"]);
        expect(mac.polls()).toBeLessThan(5);
    });

    test("grants already held are neither prompted nor opened", async () => {
        const probe = terminalProbe();
        const { route, checks } = terminalChecks(probe);
        const mac = fakeMac(probe);

        const outcome = await requestPermissions({
            checks,
            holder: route.holder,
            boundary: mac.boundary,
            signal: new AbortController().signal,
            say: mac.say,
        });

        expect(mac.prompted).toEqual([]);
        expect(mac.opened).toEqual([]);
        expect(outcome).toEqual({ granted: ["accessibility", "screen-recording"], missing: [] });
    });
});
