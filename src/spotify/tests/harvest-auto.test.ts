/**
 * The parts of `harvest --auto` that do not need a browser: extracting the shipped browser
 * payloads and filling their token placeholders.
 *
 * Both are silent-failure shaped. If `page/*.ts` is reformatted so the payload no longer
 * starts where this expects, or a placeholder is renamed, the automated harvest would
 * install a helper that authenticates as nobody and fail 401 several steps later.
 */
import { describe, expect, test } from "bun:test";
import type { CapturedRequest, RequestWaitOptions, TabDriver } from "@app/chrome-devtools/lib/tab-driver";
import { autoHarvest, payload, preparedSetupGql } from "@app/spotify/lib/browser/harvest";
import { SPOTIFY_LIBRARY_URL } from "@app/spotify/lib/browser/session";

const tokens = { authorization: "Bearer test-access-token", clientToken: "test-client-token" };

describe("payload extraction", () => {
    test.each(["setupGql", "harvestLibrary"] as const)("%s yields an evaluable arrow function", (name) => {
        const src = payload(name);
        expect(src.startsWith("async () =>")).toBe(true);
        expect(src).not.toContain("BROWSER PAYLOAD");
    });
});

/**
 * The artist payload runs in the page, so it is evaluated here with a fake `window.__gql` and a
 * `setTimeout` that does not wait, both passed in as the names the payload text refers to.
 */
describe("the artist payload", () => {
    test("a request that throws is retried, then reported, and every other artist is kept", async () => {
        const calls = new Map<string, number>();
        const gql = async (_operation: string, _hash: string, vars: { uri: string }) => {
            const n = (calls.get(vars.uri) ?? 0) + 1;
            calls.set(vars.uri, n);

            // What `fetch` throws when the network drops; unhandled, it rejected the whole batch.
            if (vars.uri === "spotify:artist:Broken" || (vars.uri === "spotify:artist:Flaky" && n === 1)) {
                throw new TypeError("Failed to fetch");
            }

            return { status: 200, json: { data: { artistUnion: { profile: { name: vars.uri }, discography: {} } } } };
        };
        const waits: number[] = [];
        const noWait = (fn: () => void, ms: number) => {
            waits.push(ms);

            return setTimeout(fn, 0);
        };

        const harvest = new Function("window", "setTimeout", `return (${payload("harvestArtists")});`)(
            { __gql: gql },
            noWait
        );
        const uris = ["spotify:artist:A", "spotify:artist:Flaky", "spotify:artist:Broken", "spotify:artist:Later"];
        const result = await harvest(uris);

        expect(result).toMatchObject({
            requested: 4,
            fetched: 3,
            errors: [{ uri: "spotify:artist:Broken", error: "request failed: Failed to fetch" }],
        });
        expect(result.artists.map((a: { uri: string }) => a.uri)).toEqual([
            "spotify:artist:A",
            "spotify:artist:Flaky",
            "spotify:artist:Later",
        ]);
        expect(calls.get("spotify:artist:Flaky")).toBe(2);
        expect(calls.get("spotify:artist:Broken")).toBe(3);
        // Backed off before each retry, and paused between the two batches of three.
        expect(waits.sort((a, b) => a - b)).toEqual([1000, 2000, 2000, 4000]);
    });
});

describe("preparedSetupGql", () => {
    test("substitutes both tokens", () => {
        const src = preparedSetupGql(tokens);
        expect(src).toContain("Bearer test-access-token");
        expect(src).toContain("test-client-token");
    });

    test("leaves no placeholder behind", () => {
        const src = preparedSetupGql(tokens);
        expect(src).not.toContain("<BEARER>");
        expect(src).not.toContain("<CLIENT_TOKEN>");
    });

    // The guard exists so a rename in page/setupGql.ts fails here rather than at runtime,
    // where the symptom is a 401 from a helper that looks correctly installed.
    test("the placeholders it depends on are still in the shipped payload", () => {
        const src = payload("setupGql");
        expect(src).toContain("Bearer <BEARER>");
        expect(src).toContain("<CLIENT_TOKEN>");
    });
});

/**
 * The success path, which a signed-in Spotify account is otherwise the only way to reach.
 *
 * This covers what a logged-out browser cannot: reading the tokens off a pathfinder request,
 * installing the helper with them, and walking the library. The fake answers the way the CDP
 * tab driver does: evaluated payloads return plain objects, and a request wait returns the
 * first matching request with lower-cased header names.
 */
describe("autoHarvest success path", () => {
    const PATHFINDER: CapturedRequest = {
        url: "https://api-partner.spotify.com/pathfinder/v2/query",
        method: "POST",
        headers: { "client-token": "test-client-token", authorization: "Bearer test-access-token" },
    };

    interface FakeOptions {
        /** When the page sends its pathfinder request: on its own, or only once the library loads. */
        requestWhen?: "idle" | "navigate";
        probeStatus?: number;
    }

    function fake({ requestWhen = "idle", probeStatus = 200 }: FakeOptions = {}) {
        const evaluated: string[] = [];
        const waits: RequestWaitOptions[] = [];
        let closed = false;

        const driver: TabDriver = {
            tabs: async () => [
                { id: "tab-spotify", url: "https://open.spotify.com/collection/tracks", title: "Liked Songs" },
            ],
            evaluate: async (_tabId, source) => {
                // The sign-in probe runs first, and it asks the PAGE, not the traffic.
                if (source.includes("now-playing-widget") && source.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) {
                    return { ok: true };
                }

                evaluated.push(source);

                if (source.includes("window.__H")) {
                    return probeStatus === 200
                        ? { installed: true, probeStatus, totalLikedTracks: 2 }
                        : { installed: true, probeStatus, hint: "token expired" };
                }

                return {
                    total: 2,
                    fetched: 2,
                    unique: 2,
                    requests: 1,
                    errors: [],
                    tracks: [
                        { uri: "spotify:track:a", name: "A", playcount: 100 },
                        { uri: "spotify:track:b", name: "B", playcount: 200 },
                    ],
                };
            },
            navigate: async () => true,
            open: async () => {
                throw new Error("a Spotify tab is open; nothing should open another");
            },
            waitForRequest: async (_tabId, options) => {
                waits.push(options);
                const sends = requestWhen === "idle" || options.cause !== undefined;
                const request = sends && options.matches(PATHFINDER) ? PATHFINDER : null;

                return { request, seen: sends ? [PATHFINDER.url] : [] };
            },
            close: () => {
                closed = true;
            },
        };

        return { driver, evaluated, waits, isClosed: () => closed };
    }

    test("reads the tokens, installs the helper with them, and returns the library", async () => {
        const f = fake();
        const result = await autoHarvest({ browserUrl: "http://127.0.0.1:9222", onLog: () => {}, driver: f.driver });

        expect(result.unique).toBe(2);
        expect(result.tracks).toHaveLength(2);

        // The tokens from the request must reach the installed helper verbatim; a placeholder
        // surviving here is the silent failure preparedSetupGql guards against.
        const setup = f.evaluated.find((s) => s.includes("window.__H"));
        expect(setup).toContain("Bearer test-access-token");
        expect(setup).toContain("test-client-token");
        expect(setup).not.toContain("<BEARER>");

        // An active tab answered the first, passive wait, so the page was not reloaded.
        expect(f.waits).toHaveLength(1);
        expect(f.waits[0]?.cause).toBeUndefined();
        // The driver was the caller's, so the harvest leaves it open.
        expect(f.isClosed()).toBe(false);
    });

    test("an idle tab is made to send a request by loading the library", async () => {
        const f = fake({ requestWhen: "navigate" });
        const lines: string[] = [];
        const result = await autoHarvest({
            browserUrl: "http://127.0.0.1:9222",
            onLog: (line) => lines.push(line),
            driver: f.driver,
        });

        expect(result.unique).toBe(2);
        expect(f.waits).toHaveLength(2);
        expect(f.waits[1]?.cause).toEqual({ navigate: SPOTIFY_LIBRARY_URL });
        expect(lines).toContain("no pathfinder request yet, loading the library to make one");
    });

    test("a non-200 probe fails loudly instead of harvesting nothing", async () => {
        const f = fake({ probeStatus: 401 });

        await expect(
            autoHarvest({ browserUrl: "http://127.0.0.1:9222", onLog: () => {}, driver: f.driver })
        ).rejects.toThrow(/401|token expired/);
        // Only the helper was installed; the library walk never ran.
        expect(f.evaluated).toHaveLength(1);
    });
});
