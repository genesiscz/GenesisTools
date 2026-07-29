import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { TimelyHttpError } from "@app/timely/api/errors";
import type { TimelyAccount } from "@app/timely/types";
import { logger } from "@genesiscz/utils/logger";
import { reportTimelyFailure } from "./failure";

const errors: string[] = [];
const infos: string[] = [];

/** pino takes either (message) or (mergingObject, message), so keep whichever argument is the text. */
function record(target: string[]) {
    return (...args: unknown[]) => {
        target.push(args.filter((arg) => typeof arg === "string").join(" "));
    };
}

// `logger` is a shared singleton and bun runs every test file in one process,
// so a module-level spy would stay installed for files that run after this one.
let restoreLogger: (() => void) | undefined;

beforeAll(() => {
    const errorSpy = spyOn(logger, "error").mockImplementation(record(errors));
    const infoSpy = spyOn(logger, "info").mockImplementation(record(infos));

    restoreLogger = () => {
        errorSpy.mockRestore();
        infoSpy.mockRestore();
    };
});

afterEach(() => {
    errors.length = 0;
    infos.length = 0;
});

afterAll(() => {
    restoreLogger?.();
});

function liveSession(): { getAccounts: () => Promise<TimelyAccount[]>; calls: number } {
    const probe = {
        calls: 0,
        getAccounts: async (): Promise<TimelyAccount[]> => {
            probe.calls++;
            return [];
        },
    };
    return probe;
}

function deadSession(): { getAccounts: () => Promise<TimelyAccount[]>; calls: number } {
    const probe = {
        calls: 0,
        getAccounts: async (): Promise<TimelyAccount[]> => {
            probe.calls++;
            throw new TimelyHttpError("API request failed (401): Unauthorized", { status: 401, scope: "api" });
        },
    };
    return probe;
}

describe("reportTimelyFailure", () => {
    test("a rejected session says to log in again", async () => {
        const probe = deadSession();

        await reportTimelyFailure(new TimelyHttpError("nope", { status: 401, scope: "api" }), probe);

        expect(errors.join("\n")).toContain("no longer valid");
        expect(infos.join("\n")).toContain("tools timely login api-key");
    });

    test("no stored cookie with a live API session points at the cookie login", async () => {
        const probe = liveSession();

        await reportTimelyFailure(new TimelyHttpError("nope", { status: 401, scope: "memories" }), probe);

        expect(probe.calls).toBe(1);
        expect(errors.join("\n")).toContain("browser session cookie");
        expect(infos.join("\n")).toContain("tools timely login cookies");
        expect(infos.join("\n")).not.toContain("login api-key");
    });

    test("a stored cookie that stopped working says the cookie expired, without probing", async () => {
        const probe = liveSession();

        await reportTimelyFailure(
            new TimelyHttpError("nope", { status: 401, scope: "memories", usedCookie: true }),
            probe
        );

        expect(probe.calls).toBe(0);
        expect(errors.join("\n")).toContain("cookie has expired");
        expect(infos.join("\n")).toContain("tools timely login cookies");
    });

    test("a sign-in redirect with a stored cookie says the cookie expired, not 'request failed'", async () => {
        const probe = liveSession();

        await reportTimelyFailure(
            new TimelyHttpError("bounced", { status: 302, scope: "memories", usedCookie: true }),
            probe
        );

        expect(probe.calls).toBe(0);
        expect(errors.join("\n")).toContain("cookie has expired");
        expect(errors.join("\n")).not.toContain("request failed");
        expect(infos.join("\n")).toContain("tools timely login cookies");
    });

    test("a memories 401 with a dead session still says to log in again", async () => {
        const probe = deadSession();

        await reportTimelyFailure(new TimelyHttpError("nope", { status: 401, scope: "memories" }), probe);

        expect(probe.calls).toBe(1);
        expect(errors.join("\n")).toContain("no longer valid");
        expect(infos.join("\n")).toContain("tools timely login api-key");
    });

    test("a non-auth HTTP failure reports the status without a login suggestion", async () => {
        const probe = liveSession();

        await reportTimelyFailure(new TimelyHttpError("boom", { status: 500, scope: "api" }), probe);

        expect(probe.calls).toBe(0);
        expect(errors.join("\n")).toContain("HTTP 500");
        expect(infos.join("\n")).not.toContain("tools timely login");
    });

    test("a refused refresh points at login without probing", async () => {
        const probe = liveSession();

        await reportTimelyFailure(
            new TimelyHttpError("Token refresh failed: bad grant", { status: 400, scope: "token" }),
            probe
        );

        expect(probe.calls).toBe(0);
        expect(errors.join("\n")).toContain("refresh");
        expect(infos.join("\n")).toContain("tools timely login api-key");
    });

    test("a non-HTTP error keeps the old unexpected-error line", async () => {
        const probe = liveSession();

        await reportTimelyFailure(new Error("socket hang up"), probe);

        expect(probe.calls).toBe(0);
        expect(errors.join("\n")).toContain("Unexpected error talking to Timely");
    });
});
