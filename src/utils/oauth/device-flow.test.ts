import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceFlowConfig } from "@genesiscz/utils/oauth/types";
import { pollDeviceTokenResponse } from "./device-flow.ts";

const config: DeviceFlowConfig = {
    clientId: "client-1",
    scope: "mcp:connect",
    deviceCodeUrl: "https://identity.example/device",
    tokenUrl: "https://identity.example/token",
};

const realFetch = globalThis.fetch;

/** Object.assign rather than a cast: `typeof fetch` carries `preconnect`, and this repo
 * does not use double assertions to paper over a missing property. */
function answerToken(body: unknown): void {
    globalThis.fetch = Object.assign(async () => Response.json(body), {
        preconnect: realFetch.preconnect,
    });
}

afterEach(() => {
    globalThis.fetch = realFetch;
});

function poll() {
    return pollDeviceTokenResponse({
        config,
        deviceCode: "dev-1",
        intervalSeconds: 0,
        expiresIn: 5,
    });
}

describe("pollDeviceTokenResponse validates what the caller will use", () => {
    test("a well-formed response comes back whole", async () => {
        answerToken({ access_token: "a1", expires_in: 3600, refresh_token: "r1" });

        const granted = await poll();

        expect(granted.access_token).toBe("a1");
        expect(granted.expires_in).toBe(3600);
        expect(granted.refresh_token).toBe("r1");
    });

    test("a response with neither optional field is still fine", async () => {
        answerToken({ access_token: "a1" });

        expect((await poll()).access_token).toBe("a1");
    });

    test.each([
        ["a string expires_in", { access_token: "a1", expires_in: "3600" }],
        ["a null expires_in", { access_token: "a1", expires_in: null }],
        ["a NaN expires_in", { access_token: "a1", expires_in: Number.NaN }],
        ["a negative expires_in", { access_token: "a1", expires_in: -1 }],
        ["a zero expires_in", { access_token: "a1", expires_in: 0 }],
    ])("%s is rejected rather than persisted as an invalid expiry", async (_label, body) => {
        answerToken(body);

        // Unvalidated, loginMcpServer computed Date.now() + NaN and stored an expiry
        // that never compares as expired, so the token was never refreshed.
        await expect(poll()).rejects.toThrow(/expires_in is not a positive number/);
    });

    test("a non-string refresh_token is rejected", async () => {
        answerToken({ access_token: "a1", refresh_token: 42 });

        await expect(poll()).rejects.toThrow(/refresh_token is not a string/);
    });
});
