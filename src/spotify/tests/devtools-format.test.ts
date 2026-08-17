/**
 * The chrome-devtools-mcp output shapes this tool parses.
 *
 * Every fixture below is the REAL format, captured from a live browser on 2026-08-17. The
 * first version of this parsing was written from assumption and got all three shapes wrong:
 * pages were assumed to be `1: <url>` (correct) but requests were assumed to be the same
 * (they are `reqid=1 POST <url> [200]`), and headers were assumed to be `authorization: v`
 * (they are `- authorization:v`, leading dash, no space). Nothing failed loudly — the tool
 * simply reported "no pathfinder request in the network log" forever.
 */
import { describe, expect, test } from "bun:test";
import { readPathfinderTokens, signedOutSignature } from "@app/spotify/lib/browser/session";
import type { Client } from "@modelcontextprotocol/client";

const PAGES = `## Pages
1: https://open.spotify.com/ [selected]
2: New Tab (chrome://newtab/)
3: GitHub Status (https://www.githubstatus.com/)`;

const REQUESTS = `## Network requests
Showing 1-6 of 6 (Page 1 of 1).
reqid=1 POST https://gew4-spclient.spotify.com/gabo-receiver-service/public/v3/events [200]
reqid=2 GET https://www.spotify.com/api/masthead/v1/masthead?market=cz [200]
reqid=7 POST https://api-partner.spotify.com/pathfinder/v2/query [200]
reqid=9 POST https://api-partner.spotify.com/pathfinder/v2/query [200]`;

const REQUEST_DETAIL = `## Request https://api-partner.spotify.com/pathfinder/v2/query
Status: 200
### Request Headers
- referer:https://open.spotify.com/
- client-token:AAAAtest-client-token-value
- authorization:Bearer test-access-token-value
- content-type:application/json
### Request Body
{"variables":{}}`;

/**
 * A chrome-devtools-mcp stand-in that answers the two calls the token reader makes.
 *
 * The parsing is driven through the REAL `readPathfinderTokens` rather than through copies of
 * its expressions. An earlier version of this file declared its own `PATHFINDER_REQ` and
 * friends and asserted those against the fixtures, which proves only that the fixtures match
 * the test: `session.ts` could be reverted to any of the three wrong shapes above and every
 * assertion here still passed.
 */
function client(requests: string, detail: string): Client {
    const calls: string[] = [];

    return {
        callTool: async ({ name }: { name: string }) => {
            calls.push(name);

            return {
                content: [{ type: "text", text: name === "list_network_requests" ? requests : detail }],
            };
        },
        calls,
    } as unknown as Client;
}

describe("list_pages", () => {
    test("finds the Spotify tab and its id", () => {
        const ids = [...PAGES.matchAll(/^\s*(\d+):\s*(.+)$/gm)]
            .filter((m) => m[2]?.includes("open.spotify.com"))
            .map((m) => m[1]);

        expect(ids).toEqual(["1"]);
    });
});

describe("readPathfinderTokens", () => {
    test("reads both tokens out of the real output shapes", async () => {
        const tokens = await readPathfinderTokens(client(REQUESTS, REQUEST_DETAIL));

        expect(tokens).toEqual({
            authorization: "Bearer test-access-token-value",
            clientToken: "AAAAtest-client-token-value",
        });
    });

    // Each of the three shapes the first version assumed. Feeding output that only a wrong
    // parser would accept proves the right one is in place, which asserting on a local copy
    // of the expression cannot.
    test("does not accept the page-list shape as a request line", async () => {
        const asPages = "## Network requests\n7: https://api-partner.spotify.com/pathfinder/v2/query";
        const tokens = await readPathfinderTokens(client(asPages, REQUEST_DETAIL));

        expect(tokens).toEqual({ failure: "no-requests" });
    });

    test("reads headers written with a leading dash and no space", async () => {
        // The assumed `authorization: value` shape is absent from the fixture on purpose: if
        // the parser regressed to requiring it, this returns a failure instead of tokens.
        expect(REQUEST_DETAIL).not.toMatch(/^authorization:\s+/im);
        expect(REQUEST_DETAIL).toMatch(/^- authorization:Bearer/im);

        const tokens = await readPathfinderTokens(client(REQUESTS, REQUEST_DETAIL));
        expect(tokens).not.toHaveProperty("failure");
    });

    test("a pathfinder request carrying no usable headers is a failure, not a half-token", async () => {
        const headerless = "## Request\nStatus: 200\n### Request Headers\n- referer:https://open.spotify.com/";
        const tokens = await readPathfinderTokens(client(REQUESTS, headerless));

        expect(tokens).toEqual({ failure: "no-requests" });
    });
});

describe("signed-out detection", () => {
    // Captured from a real logged-out browser: navigating to the player redirects to the
    // marketing site, which calls www.spotify.com/api/* and never touches api-partner. Both
    // this and an idle signed-in tab yield zero pathfinder requests, but only the idle one is
    // fixed by waiting — telling a logged-out user to "let the page finish loading" sends
    // them in circles.
    const SIGNED_OUT = `## Network requests
reqid=1 POST https://gew4-spclient.spotify.com/gabo-receiver-service/public/v3/events [200]
reqid=2 GET https://www.spotify.com/api/masthead/v1/masthead?market=cz [200]`;

    const IDLE_SIGNED_IN = `## Network requests
reqid=1 GET https://open.spotifycdn.com/cdn/build/web-player/vendor~web-player.js [200]
reqid=2 POST https://gew4-spclient.spotify.com/melody/v1/logs [200]`;

    const PLAYING = `## Network requests
reqid=7 POST https://api-partner.spotify.com/pathfinder/v2/query [200]`;

    test("recognises the logged-out marketing site", () => {
        expect(signedOutSignature(SIGNED_OUT)).toBe(true);
    });

    test("does not cry signed-out for an idle signed-in tab", () => {
        expect(signedOutSignature(IDLE_SIGNED_IN)).toBe(false);
    });

    test("does not cry signed-out when pathfinder is clearly in use", () => {
        expect(signedOutSignature(PLAYING)).toBe(false);
    });
});
