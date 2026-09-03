import { describe, expect, it } from "bun:test";
import type { CalendarAuthorizedResult, CalendarInfo } from "@genesiscz/darwinkit";
import {
    CALENDAR_PLACEHOLDER_IDENTIFIER,
    type CalendarAuthClient,
    CalendarPermissionError,
    isPlaceholderCalendarList,
    resolveCalendarReadAccess,
    resolveCalendarWriteAccess,
} from "../apple-calendar";

interface FakeAuth extends CalendarAuthClient {
    requests: number;
}

type AuthStatus = CalendarAuthorizedResult["status"];

function fakeAuth(status: AuthStatus, afterUpgrade: AuthStatus = status): FakeAuth {
    const auth: FakeAuth = {
        requests: 0,
        authorized: async () => ({ status, authorized: status === "fullAccess" }),
        requestFullAccess: async () => {
            auth.requests++;
            return { status: afterUpgrade, authorized: afterUpgrade === "fullAccess" };
        },
    };
    return auth;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }

    return null;
}

describe("resolveCalendarReadAccess", () => {
    it("passes on fullAccess without asking for an upgrade", async () => {
        const auth = fakeAuth("fullAccess");
        const result = await resolveCalendarReadAccess(auth, { requestUpgrade: true });
        expect(result.status).toBe("fullAccess");
        expect(auth.requests).toBe(0);
    });

    it("fails loudly on writeOnly (Add Only) and names the setting to flip", async () => {
        const auth = fakeAuth("writeOnly");
        const error = await rejection(resolveCalendarReadAccess(auth, { requestUpgrade: false }));
        expect(error).toBeInstanceOf(CalendarPermissionError);
        const perm = error as CalendarPermissionError;
        expect(perm.status).toBe("writeOnly");
        expect(perm.message).toContain("Add Only");
        expect(perm.message).toContain("Privacy & Security > Calendars");
        expect(perm.message).toContain("Full Access");
        expect(perm.message).toContain("tools macos calendar doctor");
        expect(auth.requests).toBe(0);
    });

    it("asks macOS once to upgrade writeOnly when requestUpgrade is on, and passes if granted", async () => {
        const auth = fakeAuth("writeOnly", "fullAccess");
        const result = await resolveCalendarReadAccess(auth, { requestUpgrade: true });
        expect(result.status).toBe("fullAccess");
        expect(auth.requests).toBe(1);
    });

    it("still fails when the upgrade is refused", async () => {
        const auth = fakeAuth("writeOnly");
        const error = await rejection(resolveCalendarReadAccess(auth, { requestUpgrade: true }));
        expect(error).toBeInstanceOf(CalendarPermissionError);
        expect(auth.requests).toBe(1);
    });

    it.each([
        "denied",
        "restricted",
        "notDetermined",
    ] as const)("fails on %s without an upgrade attempt", async (status) => {
        const auth = fakeAuth(status);
        const error = await rejection(resolveCalendarReadAccess(auth, { requestUpgrade: true }));
        expect(error).toBeInstanceOf(CalendarPermissionError);
        expect((error as CalendarPermissionError).status).toBe(status);
        expect(auth.requests).toBe(0);
    });
});

describe("resolveCalendarWriteAccess", () => {
    it("accepts writeOnly and fullAccess", async () => {
        expect((await resolveCalendarWriteAccess(fakeAuth("writeOnly"))).status).toBe("writeOnly");
        expect((await resolveCalendarWriteAccess(fakeAuth("fullAccess"))).status).toBe("fullAccess");
    });

    it("rejects denied", async () => {
        const error = await rejection(resolveCalendarWriteAccess(fakeAuth("denied")));
        expect(error).toBeInstanceOf(CalendarPermissionError);
        expect((error as CalendarPermissionError).message).toContain("Add Only or Full Access");
    });
});

describe("isPlaceholderCalendarList", () => {
    const base: CalendarInfo = {
        identifier: "REAL-1",
        title: "Work",
        type: "exchange",
        color: "#000000",
        is_immutable: false,
        allows_content_modifications: true,
        source: "hello@example.com",
    };

    it("recognises the single EventKit placeholder by identifier", () => {
        expect(isPlaceholderCalendarList([{ ...base, identifier: CALENDAR_PLACEHOLDER_IDENTIFIER }])).toBe(true);
    });

    it("recognises the placeholder by its Calendar/Account shape", () => {
        expect(isPlaceholderCalendarList([{ ...base, title: "Calendar", source: "Account" }])).toBe(true);
    });

    it("does not flag real calendars", () => {
        expect(isPlaceholderCalendarList([base])).toBe(false);
        expect(isPlaceholderCalendarList([base, { ...base, identifier: CALENDAR_PLACEHOLDER_IDENTIFIER }])).toBe(false);
        expect(isPlaceholderCalendarList([])).toBe(false);
    });
});
