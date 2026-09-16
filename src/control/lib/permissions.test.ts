import { describe, expect, test } from "bun:test";
import type { TccRow } from "@app/macos/lib/permissions/tcc";
import {
    type AxLivePermissions,
    buildChecks,
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
};

const unrouted: ResponsibleRoute = {
    launcher: null,
    routed: false,
    identity: "the terminal or host app (com.example.terminal)",
    bundleId: "com.example.terminal",
    reason: "GENESIS_TOOLS_NO_APP=1 is set",
};

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
    });

    test("a launcher that macOS did not hold responsible is reported, not hidden", () => {
        const probe = live({ viaGenesisApp: false, responsibleBundleId: "", responsiblePath: "/usr/local/bin/bun" });
        const checks = buildChecks({ route: routed, live: probe, system: fullSystem, user: fullUser });
        const problems = collectProblems({ route: routed, checks, live: probe });

        expect(problems.some((p) => p.includes("held pid 4242 (/usr/local/bin/bun) responsible"))).toBe(true);
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

        expect(refined.identity).toBe("pid 4242 (/usr/local/bin/bun), not GenesisTools.app");
        expect(refined.bundleId).toBe("/usr/local/bin/bun");
        expect(refined.routed).toBe(false);
    });
});
