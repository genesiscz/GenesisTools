import { describe, expect, it, test } from "bun:test";
import { isThisProcessRow } from "../calendar/doctor";
import type { RemindersDoctorReport } from "./doctor";
import { buildRemindersVerdict, type RemindersDoctorDeps, readTccRemindersRows, runRemindersDoctor } from "./doctor";

function doctorDeps(status: string, calls: string[]): RemindersDoctorDeps {
    return {
        binaryPath: async () => "/tmp/no-bundle/darwinkit",
        readTcc: () => ({ readable: false, rows: [], error: "authorization denied" }),
        authorizationStatus: async () => {
            calls.push("status");
            return { status, authorized: status === "fullAccess" };
        },
        requestAccess: async () => {
            calls.push("request");
            return { status: "fullAccess", authorized: true };
        },
        listCount: async () => {
            calls.push("lists");
            return 3;
        },
    };
}

// Regression test: PR #456 review round 5 — once the status was always read, a fresh Mac's
// notDetermined fell to the default branch and was told to flip a switch that does not exist yet
describe("buildRemindersVerdict for a process macOS never asked", () => {
    it("names the command that asks, not the System Settings switch", () => {
        const verdict = buildRemindersVerdict({ status: "notDetermined", listCount: 0 });

        expect(verdict.verdict).toContain("has not asked");
        expect(verdict.fix).toContain("--request-access");
        expect(verdict.fix).not.toContain("set ");
    });
});

// Regression test: PR #456 review round 4 — the Reminders status read never prompts, yet the doctor
// skipped it whenever TCC.db was unreadable, so a granted process was reported as never asked
describe("runRemindersDoctor", () => {
    it("reads the status even when TCC.db is unreadable, and never requests access", async () => {
        const calls: string[] = [];
        const report = await runRemindersDoctor({}, doctorDeps("fullAccess", calls));

        expect(report.authorized).toBe(true);
        expect(report.promptSkipped).toBe(false);
        expect(report.listCount).toBe(3);
        expect(calls).toEqual(["status", "lists"]);
    });

    it("asks macOS only with --request-access, and only while the status is notDetermined", async () => {
        const plain: string[] = [];
        await runRemindersDoctor({}, doctorDeps("notDetermined", plain));
        expect(plain).toEqual(["status"]);

        const asked: string[] = [];
        const report = await runRemindersDoctor({ requestAccess: true }, doctorDeps("notDetermined", asked));
        expect(asked).toEqual(["status", "request", "lists"]);
        expect(report.authorized).toBe(true);

        const denied: string[] = [];
        await runRemindersDoctor({ requestAccess: true }, doctorDeps("denied", denied));
        expect(denied).toEqual(["status"]);
    });
});

// Regression test: #449 — `tools macos reminders doctor`, same shape as the calendar one.
describe("buildRemindersVerdict", () => {
    it("tells a denied process from an empty Reminders store", () => {
        const denied = buildRemindersVerdict({ status: "denied", listCount: 0 });
        expect(denied.verdict).toContain("denied");
        expect(denied.fix).toContain("Privacy & Security > Reminders");

        const empty = buildRemindersVerdict({ status: "fullAccess", listCount: 0 });
        expect(empty.verdict).toContain("really is empty");
        expect(empty.fix).toBeUndefined();
    });

    it("reports the visible list count under full access", () => {
        expect(buildRemindersVerdict({ status: "fullAccess", listCount: 7 }).verdict).toContain("7 reminder lists");
    });

    it("names the fix for restricted access", () => {
        const restricted = buildRemindersVerdict({ status: "restricted", listCount: 0 });
        expect(restricted.verdict).toContain("restricted");
        expect(restricted.fix).toContain("Privacy & Security > Reminders");
    });

    it("says the status was not read when the prompt was skipped, and names the command that asks", () => {
        // CLAUDE.md: a diagnostic may READ durable state and REPORT on it, and nothing
        // else. The macOS Reminders dialog writes a durable TCC row.
        const verdict = buildRemindersVerdict({ status: "notDetermined", listCount: 0, promptSkipped: true });
        expect(verdict.verdict).toContain("did not ask");
        expect(verdict.fix).toContain("tools macos reminders list-lists");
    });

    it("gives a recorded notDetermined status its normal verdict, not the skipped one", () => {
        const verdict = buildRemindersVerdict({ status: "notDetermined", listCount: 0, promptSkipped: false });
        expect(verdict.verdict).toContain("has not asked");
        expect(verdict.verdict).not.toContain("did not ask");
        expect(verdict.fix).toBeDefined();
    });
});

describe("readTccRemindersRows", () => {
    it("reports an unreadable database instead of an empty grant list", () => {
        const result = readTccRemindersRows("/nonexistent/dir/TCC.db");
        expect(result.readable).toBe(false);
        expect(result.rows).toEqual([]);
        expect(result.error).toBeTruthy();
    });
});

test("RemindersDoctorReport shape stays importable", () => {
    const report: RemindersDoctorReport["tcc"] = { readable: true, rows: [] };
    expect(report.rows).toEqual([]);
});

// Regression test: PR #456 review — the doctor marked only bundle-id rows, so a path-keyed row
// (client_type 1, the one `tccDecisionRecorded` also accepts) never read "<- this process"
describe("isThisProcessRow", () => {
    const identity = { bundleId: "com.example.terminal", executablePath: "/opt/fixture/bin/bun" };

    function tccRow(clientType: number, client: string) {
        return {
            service: "kTCCServiceReminders",
            client,
            clientType,
            authValue: 2,
            label: "allowed",
            lastModified: "2026-10-04T00:00:00.000Z",
        };
    }

    it("matches a bundle-id row by the responsible bundle id", () => {
        expect(isThisProcessRow(tccRow(0, "com.example.terminal"), identity)).toBe(true);
    });

    it("matches a path row by this process's executable path", () => {
        expect(isThisProcessRow(tccRow(1, "/opt/fixture/bin/bun"), identity)).toBe(true);
    });

    it("never matches a row of the other kind or another client", () => {
        expect(isThisProcessRow(tccRow(1, "com.example.terminal"), identity)).toBe(false);
        expect(isThisProcessRow(tccRow(0, "/opt/fixture/bin/bun"), identity)).toBe(false);
        expect(isThisProcessRow(tccRow(0, "com.example.other"), identity)).toBe(false);
        expect(isThisProcessRow(tccRow(0, "com.example.terminal"), { executablePath: "/opt/fixture/bin/bun" })).toBe(
            false
        );
    });
});
