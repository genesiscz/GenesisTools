import { afterAll, describe, expect, test } from "bun:test";
import { ClarityClient, isClarityAuthError } from "@app/clarity/lib/auth/client";
import {
    authDrivers,
    chooseAuthDriver,
    DEFAULT_AUTH_DRIVER,
    findAuthDriver,
    savedAuthDriver,
} from "@app/clarity/lib/auth/drivers";

const server = Bun.serve({ port: 0, fetch: () => new Response("", { status: 401 }) });

afterAll(() => {
    server.stop(true);
});

describe("clarity auth drivers", () => {
    test("a config saved before drivers existed reads as the cURL driver", () => {
        expect(savedAuthDriver(undefined)?.id).toBe(DEFAULT_AUTH_DRIVER);
    });

    test("a driver this build does not have is no driver, not an error", () => {
        expect(savedAuthDriver("elsewhere")).toBeUndefined();
    });

    test("an unknown --driver names the ones that exist", () => {
        expect(() => findAuthDriver("elsewhere")).toThrow(/Use one of: curl/);
    });

    test("--driver wins without a question", async () => {
        expect((await chooseAuthDriver("curl", undefined))?.id).toBe("curl");
    });

    // A build with extra drivers asks instead, so this only holds where cURL is the only one.
    test.if(authDrivers().length === 1)("a single driver needs no question", async () => {
        expect((await chooseAuthDriver(undefined, "elsewhere"))?.id).toBe("curl");
    });

    test("a 401 surfaces as it is when the saved driver cannot renew", async () => {
        const client = new ClarityClient({
            baseUrl: `http://localhost:${server.port}`,
            authToken: "token",
            sessionId: "test",
            auth: { driver: "curl" },
        });

        await expect(client.getTimesheetApp(0)).rejects.toThrow("Clarity API error 401");
    });

    test("a 401 from the API reads as an expired session", () => {
        expect(isClarityAuthError(new Error("Clarity API error 401: "))).toBe(true);
        expect(isClarityAuthError(new Error("Clarity API error 500: boom"))).toBe(false);
    });
});
