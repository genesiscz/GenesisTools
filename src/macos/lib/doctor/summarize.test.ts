import { describe, expect, it } from "bun:test";
import type { NotificationCenterStatus } from "@genesiscz/utils/macos/notifications";
import type { PermissionsReport } from "../permissions/report";
import {
    combineDoctorChecks,
    summarizeCalendarCheck,
    summarizeNotificationsCheck,
    summarizePermissionsCheck,
    summarizeRemindersCheck,
} from "./summarize";

function notificationStatusFixture(overrides: Partial<NotificationCenterStatus>): NotificationCenterStatus {
    return {
        authorization: "authorized",
        alertSetting: "enabled",
        alertStyle: "alert",
        soundSetting: "enabled",
        badgeSetting: "enabled",
        notificationCenterSetting: "enabled",
        lockScreenSetting: "enabled",
        criticalAlertSetting: "notSupported",
        timeSensitiveSetting: "notSupported",
        bundleId: "com.genesiscz.genesistools",
        bundlePath: "/Users/test/Applications/GenesisTools.app",
        temporary: false,
        settingsUrl: "x-apple.systempreferences:com.apple.preference.notifications",
        ...overrides,
    };
}

// Regression test: round-2 D7 — `tools macos doctor` runs every read-only check in one pass,
// prints one section each, and exits 1 if any failed. These pure mappers decide pass/fail per
// check so the orchestration (which calls the real, side-effect-prone report functions) stays
// thin and untested glue, matching the existing calendar-doctor split.
describe("summarizePermissionsCheck", () => {
    it("passes when there are no problems", () => {
        const report = { problems: [] } as unknown as PermissionsReport;
        expect(summarizePermissionsCheck(report).ok).toBe(true);
    });

    it("fails and lists every problem when there are any", () => {
        const report = { problems: ["GenesisTools.app is not built"] } as unknown as PermissionsReport;
        const summary = summarizePermissionsCheck(report);
        expect(summary.ok).toBe(false);
        expect(summary.lines).toEqual(["GenesisTools.app is not built"]);
    });
});

describe("summarizeCalendarCheck", () => {
    it("passes with no fix", () => {
        const summary = summarizeCalendarCheck({ verdict: "Full Access is granted; 3 calendars visible." });
        expect(summary.ok).toBe(true);
        expect(summary.lines).toEqual(["Full Access is granted; 3 calendars visible."]);
    });

    it("fails and appends the fix line when one is present", () => {
        const summary = summarizeCalendarCheck({
            verdict: "Access is denied: this process may not read the calendar.",
            fix: "System Settings > Privacy & Security > Calendars.",
        });
        expect(summary.ok).toBe(false);
        expect(summary.lines).toEqual([
            "Access is denied: this process may not read the calendar.",
            "Fix: System Settings > Privacy & Security > Calendars.",
        ]);
    });
});

describe("summarizeRemindersCheck", () => {
    it("passes with no fix", () => {
        expect(summarizeRemindersCheck({ verdict: "Access is granted; 7 reminder lists visible." }).ok).toBe(true);
    });

    it("fails when a fix is present", () => {
        expect(summarizeRemindersCheck({ verdict: "denied", fix: "fix it" }).ok).toBe(false);
    });
});

describe("summarizeNotificationsCheck", () => {
    it("passes when authorized", () => {
        const summary = summarizeNotificationsCheck(
            { ok: true, result: notificationStatusFixture({ authorization: "authorized" }) },
            { kind: "genesis-app" }
        );
        expect(summary.ok).toBe(true);
    });

    it("fails when not authorized", () => {
        const summary = summarizeNotificationsCheck(
            { ok: true, result: notificationStatusFixture({ authorization: "denied" }) },
            { kind: "genesis-app" }
        );
        expect(summary.ok).toBe(false);
    });

    it("names the terminal-notifier fallback path when the app RPC is unavailable", () => {
        const summary = summarizeNotificationsCheck(
            { ok: false, error: { code: "unavailable", message: "not installed" } },
            { kind: "terminal-notifier", path: "/opt/homebrew/bin/terminal-notifier" }
        );
        expect(summary.ok).toBe(false);
        expect(summary.lines.join(" ")).toContain("/opt/homebrew/bin/terminal-notifier");
    });

    it("says delivery cannot be confirmed when only osascript remains", () => {
        const summary = summarizeNotificationsCheck(
            { ok: false, error: { code: "unavailable", message: "not installed" } },
            { kind: "osascript-only" }
        );
        expect(summary.ok).toBe(false);
        expect(summary.lines.join(" ")).toContain("cannot be confirmed");
    });
});

describe("combineDoctorChecks", () => {
    it("passes only when every check passed", () => {
        expect(combineDoctorChecks([{ ok: true }])).toBe(true);
        expect(combineDoctorChecks([{ ok: true }, { ok: false }])).toBe(false);
    });
});
