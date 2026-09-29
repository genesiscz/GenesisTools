/**
 * Reading the pathfinder tokens off the requests a Spotify tab sends.
 *
 * Driven through the REAL `readPathfinderTokens` and `SpotifyTab` over a fake `TabDriver`
 * that replays a fixed list of requests through the caller's `matches`, the way the CDP
 * driver feeds it `Network.requestWillBeSent` events. What matters is which request is
 * accepted and how a wait that found nothing is explained: "signed out" and "not called
 * yet" both mean zero pathfinder requests, but only the second is fixed by waiting.
 */
import { describe, expect, test } from "bun:test";
import { isSpotifyUrl } from "@app/spotify/lib/browser/session";

test("a Spotify tab is matched by its exact host, never by a substring of the url", () => {
    expect(isSpotifyUrl("https://open.spotify.com/collection/tracks")).toBe(true);
    expect(isSpotifyUrl("https://open.spotify.com.evil.example/")).toBe(false);
    expect(isSpotifyUrl("http://open.spotify.com/collection/tracks")).toBe(false);
    expect(isSpotifyUrl("https://open.spotify.com:8443/")).toBe(false);
    expect(isSpotifyUrl("https://example.com/?next=open.spotify.com")).toBe(false);
    expect(isSpotifyUrl("chrome://newtab/")).toBe(false);
});

import type { CapturedRequest, TabDriver } from "@app/chrome-devtools/lib/tab-driver";
import { readPathfinderTokens, SpotifyTab, signedOutSignature } from "@app/spotify/lib/browser/session";

const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v2/query";
const EVENTS: CapturedRequest = {
    url: "https://gew4-spclient.spotify.com/gabo-receiver-service/public/v3/events",
    method: "POST",
    headers: {},
};
const MASTHEAD: CapturedRequest = {
    url: "https://www.spotify.com/api/masthead/v1/masthead?market=cz",
    method: "GET",
    headers: {},
};
const PATHFINDER: CapturedRequest = {
    url: PATHFINDER_URL,
    method: "POST",
    headers: {
        referer: "https://open.spotify.com/",
        "client-token": "test-client-token-value",
        authorization: "Bearer test-access-token-value",
        "content-type": "application/json",
    },
};

/** A browser with one Spotify tab that sends `requests`, in order, during any wait. */
async function tabSending(requests: CapturedRequest[]): Promise<SpotifyTab> {
    const driver: TabDriver = {
        tabs: async () => [{ id: "tab-spotify", url: "https://open.spotify.com/", title: "Spotify" }],
        evaluate: async () => ({ ok: true }),
        navigate: async () => true,
        open: async () => {
            throw new Error("the tests never open a tab");
        },
        waitForRequest: async (_tabId, { matches }) => {
            const seen: string[] = [];

            for (const request of requests) {
                seen.push(request.url);

                if (matches(request)) {
                    return { request, seen };
                }
            }

            return { request: null, seen };
        },
        close: () => {},
    };
    const tab = new SpotifyTab(driver);
    await tab.pin({ rescan: true });

    return tab;
}

describe("readPathfinderTokens", () => {
    test("reads both tokens off a pathfinder query", async () => {
        const tab = await tabSending([EVENTS, PATHFINDER]);

        expect(await readPathfinderTokens(tab, { timeoutMs: 100 })).toEqual({
            authorization: "Bearer test-access-token-value",
            clientToken: "test-client-token-value",
        });
    });

    test("only marketing calls mean the browser is signed out", async () => {
        const tab = await tabSending([EVENTS, MASTHEAD]);

        expect(await readPathfinderTokens(tab, { timeoutMs: 100 })).toEqual({ failure: "signed-out" });
    });

    test("no pathfinder query from a signed-in tab means it has not called one yet", async () => {
        const tab = await tabSending([EVENTS]);

        expect(await readPathfinderTokens(tab, { timeoutMs: 100 })).toEqual({ failure: "no-requests" });
    });

    // A half-token would install a helper that authenticates as nobody and fails 401 later.
    test.each([
        ["no client-token", { authorization: "Bearer test-access-token-value" }],
        ["no authorization", { "client-token": "test-client-token-value" }],
        ["a non-Bearer authorization", { authorization: "Basic dGVzdA==", "client-token": "test-client-token-value" }],
    ])("a pathfinder query with %s is not accepted", async (_label, headers) => {
        const tab = await tabSending([{ url: PATHFINDER_URL, method: "POST", headers }]);

        expect(await readPathfinderTokens(tab, { timeoutMs: 100 })).toEqual({ failure: "no-requests" });
    });

    test("a later complete query is taken over an earlier incomplete one", async () => {
        const incomplete = { url: PATHFINDER_URL, method: "POST", headers: { authorization: "Bearer stale" } };
        const tab = await tabSending([incomplete, PATHFINDER]);

        expect(await readPathfinderTokens(tab, { timeoutMs: 100 })).toMatchObject({
            authorization: "Bearer test-access-token-value",
        });
    });

    test("tokens carried by another url are not taken", async () => {
        const tab = await tabSending([{ ...PATHFINDER, url: "https://api-partner.spotify.com/other/v1/query" }]);

        expect(await readPathfinderTokens(tab, { timeoutMs: 100 })).toEqual({ failure: "no-requests" });
    });
});

describe("signed-out detection", () => {
    // Captured from a real logged-out browser: navigating to the player redirects to the
    // marketing site, which calls www.spotify.com/api/* and never touches api-partner. Both
    // this and an idle signed-in tab yield zero pathfinder requests, but only the idle one is
    // fixed by waiting — telling a logged-out user to "let the page finish loading" sends
    // them in circles.
    const SIGNED_OUT = [EVENTS.url, MASTHEAD.url].join("\n");
    const IDLE_SIGNED_IN = [
        "https://open.spotifycdn.com/cdn/build/web-player/vendor~web-player.js",
        "https://gew4-spclient.spotify.com/melody/v1/logs",
    ].join("\n");

    test("recognises the logged-out marketing site", () => {
        expect(signedOutSignature(SIGNED_OUT)).toBe(true);
    });

    test("does not cry signed-out for an idle signed-in tab", () => {
        expect(signedOutSignature(IDLE_SIGNED_IN)).toBe(false);
    });

    test("does not cry signed-out when pathfinder is clearly in use", () => {
        expect(signedOutSignature([MASTHEAD.url, PATHFINDER_URL].join("\n"))).toBe(false);
    });
});
