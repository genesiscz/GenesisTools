import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceFlowConfig } from "@genesiscz/utils/oauth/types";
import { pollDeviceTokenResponse, startDeviceFlow } from "./device-flow.ts";

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

/**
 * The device-code deadline, in seconds, and why it is this small.
 *
 * `pollDeviceTokenResponse` sleeps BEFORE its first request, for
 * `min(max(1000ms, interval) * 1.2, time left on the deadline)`. `intervalSeconds: 0`
 * therefore still waits out the 1000 ms floor times 1.2, and eight tests paid 1.2 s
 * each: the file measured 9.75 s of which 9.6 s was that sleep. Capping the deadline
 * caps the sleep instead, and the first iteration still runs to completion because
 * `Date.now() < deadline` is only re-checked at the TOP of the loop — so every case
 * below exercises the same sleep -> fetch -> validate path it always did.
 */
const DEADLINE_SECONDS = 0.05;

function poll() {
    return pollDeviceTokenResponse({
        config,
        deviceCode: "dev-1",
        intervalSeconds: 0,
        expiresIn: DEADLINE_SECONDS,
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

describe("a confidential client sends its secret", () => {
    /** Records the form body of the single request the call under test makes. */
    function captureForm(body: unknown): { read: () => URLSearchParams | undefined } {
        let seen: URLSearchParams | undefined;
        globalThis.fetch = Object.assign(
            async (_url: string | URL | Request, init?: RequestInit) => {
                seen = new URLSearchParams(String(init?.body));

                return Response.json(body);
            },
            {
                preconnect: realFetch.preconnect,
            }
        );

        return { read: () => seen };
    }

    test("startDeviceFlow posts client_secret when the client has one", async () => {
        const capture = captureForm({
            device_code: "dev-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://identity.example/activate",
            interval: 5,
            expires_in: 600,
        });

        await startDeviceFlow({ ...config, clientSecret: "s3cret" });

        expect(capture.read()?.get("client_secret")).toBe("s3cret");
    });

    test("startDeviceFlow omits client_secret for a public client", async () => {
        const capture = captureForm({
            device_code: "dev-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://identity.example/activate",
            interval: 5,
            expires_in: 600,
        });

        await startDeviceFlow(config);

        expect(capture.read()?.has("client_secret")).toBe(false);
    });

    test("the token poll posts client_secret when the client has one", async () => {
        const capture = captureForm({ access_token: "a1", expires_in: 3600 });

        await pollDeviceTokenResponse({
            config: { ...config, clientSecret: "s3cret" },
            deviceCode: "dev-1",
            intervalSeconds: 0,
            expiresIn: DEADLINE_SECONDS,
        });

        expect(capture.read()?.get("client_secret")).toBe("s3cret");
    });

    test("the token poll omits client_secret for a public client", async () => {
        const capture = captureForm({ access_token: "a1", expires_in: 3600 });

        await poll();

        expect(capture.read()?.has("client_secret")).toBe(false);
    });
});
