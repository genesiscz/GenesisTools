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
import {
    ARTIST_PACING,
    artistHarvestBudgetMs,
    autoHarvest,
    autoHarvestArtists,
    payload,
    preparedSetupGql,
} from "@app/spotify/lib/browser/harvest";
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
 * A fake clock for the artist payload: `setTimeout`, `clearTimeout` and `Date.now` that move only
 * when `run` fires the next timer, after one real tick has let every pending promise settle. Start
 * times come out exact, and a 15 s deadline costs nothing.
 */
function fakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();

    const setTimeoutFake = (fn: () => void, ms = 0) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });

        return id;
    };

    async function run<T>(work: Promise<T>): Promise<T> {
        let settled = false;
        work.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );

        // A bound, so a payload that waits on itself fails the test instead of hanging it.
        for (let step = 0; step < 10_000; step++) {
            await new Promise((resolve) => setImmediate(resolve));
            if (settled) {
                return work;
            }

            const [id, timer] = [...timers].sort(([ia, a], [ib, b]) => a.at - b.at || ia - ib)[0] ?? [];
            if (id === undefined || !timer) {
                throw new Error("the payload is waiting, but no timer is pending");
            }

            timers.delete(id);
            now = Math.max(now, timer.at);
            timer.fn();
        }

        throw new Error("the payload did not finish within 10,000 timer steps");
    }

    return {
        now: () => now,
        after: (ms: number) => new Promise<void>((resolve) => setTimeoutFake(resolve, ms)),
        setTimeout: setTimeoutFake,
        clearTimeout: (id: number) => {
            timers.delete(id);
        },
        run,
    };
}

type Gql = (operation: string, hash: string, vars: { uri: string }, options?: { signal?: AbortSignal }) => unknown;

interface ArtistPayloadResult {
    requested: number;
    fetched: number;
    errors: { uri: string; error: string }[];
    artists: { uri: string }[];
}

/**
 * The payload text, evaluated with the fake page and clock in place of the names it uses, and
 * called with the same `ARTIST_PACING` that `autoHarvestArtists` passes.
 */
function artistPayload(
    gql: Gql,
    clock: ReturnType<typeof fakeClock>
): (uris: string[]) => Promise<ArtistPayloadResult> {
    const harvest: (uris: string[], pacing: typeof ARTIST_PACING) => Promise<ArtistPayloadResult> = new Function(
        "window",
        "setTimeout",
        "clearTimeout",
        "Date",
        `return (${payload("harvestArtists")});`
    )({ __gql: gql }, clock.setTimeout, clock.clearTimeout, { now: clock.now });

    return (uris) => harvest(uris, ARTIST_PACING);
}

const overview = (uri: string) => ({
    status: 200,
    json: { data: { artistUnion: { profile: { name: uri }, discography: {} } } },
});

describe("the artist payload", () => {
    test("a request that throws is retried, then reported, and every other artist is kept", async () => {
        const clock = fakeClock();
        const calls = new Map<string, number>();
        const gql: Gql = async (_operation, _hash, vars) => {
            const n = (calls.get(vars.uri) ?? 0) + 1;
            calls.set(vars.uri, n);

            // What `fetch` throws when the network drops; unhandled, it rejected the whole batch.
            if (vars.uri === "spotify:artist:Broken" || (vars.uri === "spotify:artist:Flaky" && n === 1)) {
                throw new TypeError("Failed to fetch");
            }

            return overview(vars.uri);
        };

        const uris = ["spotify:artist:A", "spotify:artist:Flaky", "spotify:artist:Broken", "spotify:artist:Later"];
        const result = await clock.run(artistPayload(gql, clock)(uris));

        expect(result).toMatchObject({
            requested: 4,
            fetched: 3,
            errors: [{ uri: "spotify:artist:Broken", error: "request failed: Failed to fetch" }],
        });
        expect(result.artists.map((a) => a.uri)).toEqual([
            "spotify:artist:A",
            "spotify:artist:Flaky",
            "spotify:artist:Later",
        ]);
        expect(calls.get("spotify:artist:Flaky")).toBe(2);
        expect(calls.get("spotify:artist:Broken")).toBe(3);
    });

    // A request that never settled never reached the retry, and held every other artist with it
    // until the outer CDP deadline gave up on the whole harvest.
    test("a request that never answers times out, is reported, and the others are kept", async () => {
        const clock = fakeClock();
        let aborted = 0;
        const gql: Gql = (_operation, _hash, vars, options) => {
            if (vars.uri === "spotify:artist:Stalled") {
                // Like `fetch`: the signal is the only way out.
                return new Promise((_resolve, reject) => {
                    options?.signal?.addEventListener("abort", () => {
                        aborted++;
                        reject(options.signal?.reason);
                    });
                });
            }

            if (vars.uri === "spotify:artist:Deaf") {
                // An older `__gql` that drops the signal: the timer race still ends the attempt.
                return new Promise(() => {});
            }

            return Promise.resolve(overview(vars.uri));
        };

        const uris = ["spotify:artist:A", "spotify:artist:Stalled", "spotify:artist:Deaf", "spotify:artist:B"];
        const result = await clock.run(artistPayload(gql, clock)(uris));

        expect(result.artists.map((a) => a.uri)).toEqual(["spotify:artist:A", "spotify:artist:B"]);
        expect(result.errors).toEqual([
            { uri: "spotify:artist:Stalled", error: "request failed: no answer within 15 s" },
            { uri: "spotify:artist:Deaf", error: "request failed: no answer within 15 s" },
        ]);
        // Each of the three attempts was cancelled, not just abandoned.
        expect(aborted).toBe(3);
    });

    // The comment promised about one request a second; three started at once and retries skipped
    // the pause, so fast answers ran at about three a second.
    test("requests start one second apart, retries included", async () => {
        const clock = fakeClock();
        const starts: [string, number][] = [];
        const tries = new Map<string, number>();
        const gql: Gql = async (_operation, _hash, vars) => {
            starts.push([vars.uri, clock.now()]);
            const n = (tries.get(vars.uri) ?? 0) + 1;
            tries.set(vars.uri, n);

            return vars.uri === "spotify:artist:Flaky" && n === 1 ? { status: 503, json: "busy" } : overview(vars.uri);
        };

        const uris = ["spotify:artist:A", "spotify:artist:Flaky", "spotify:artist:B", "spotify:artist:C"];
        const result = await clock.run(artistPayload(gql, clock)(uris));

        expect(result.fetched).toBe(4);
        expect(starts).toEqual([
            ["spotify:artist:A", 0],
            ["spotify:artist:Flaky", 1000],
            ["spotify:artist:B", 2000],
            ["spotify:artist:C", 3000],
            // The retry waited its 2 s back-off, then took the next free slot.
            ["spotify:artist:Flaky", 4000],
        ]);
    });

    test("slow answers keep at most three requests in flight, still one start a second", async () => {
        const clock = fakeClock();
        const starts: number[] = [];
        let inFlight = 0;
        let mostInFlight = 0;
        const gql: Gql = async (_operation, _hash, vars) => {
            starts.push(clock.now());
            inFlight++;
            mostInFlight = Math.max(mostInFlight, inFlight);
            await clock.after(2500);
            inFlight--;

            return overview(vars.uri);
        };

        const uris = Array.from({ length: 7 }, (_, i) => `spotify:artist:${i}`);
        const result = await clock.run(artistPayload(gql, clock)(uris));

        expect(result.fetched).toBe(7);
        expect(mostInFlight).toBe(3);
        for (const [i, at] of starts.entries()) {
            if (i > 0) {
                expect(at - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
            }
        }
    });

    // The CDP deadline was a fixed max(15 min, 3 s an artist). Stalled artists hold a worker for
    // three 15 s attempts plus back-offs, so such a run outlived it and nothing was saved.
    test("the deadline outlasts a run in which every request stalls", async () => {
        const clock = fakeClock();
        const gql: Gql = (_operation, _hash, _vars, options) =>
            new Promise((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
            });

        const uris = Array.from({ length: 60 }, (_, i) => `spotify:artist:${i}`);
        const result = await clock.run(artistPayload(gql, clock)(uris));

        expect(result.errors).toHaveLength(60);
        expect(clock.now()).toBeGreaterThan(Math.max(15 * 60_000, uris.length * 3_000));
        expect(clock.now()).toBeLessThanOrEqual(artistHarvestBudgetMs(uris.length));
    });

    test("the deadline is derived from the pacing, not fixed", () => {
        // 3 attempts x (3 workers x 1 s slot + 15 s) + 2 s + 4 s back-off = 60 s an artist.
        expect(artistHarvestBudgetMs(1)).toBe(2 * 60_000 + 60_000);
        expect(artistHarvestBudgetMs(6)).toBe(3 * 60_000 + 60_000);
        expect(artistHarvestBudgetMs(6, { ...ARTIST_PACING, attemptMs: 30_000 })).toBe(3 * 105_000 + 60_000);
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
        /** What the artist payload returns, for `autoHarvestArtists`. */
        artistResult?: unknown;
    }

    function fake({ requestWhen = "idle", probeStatus = 200, artistResult }: FakeOptions = {}) {
        const evaluated: string[] = [];
        const deadlines: (number | undefined)[] = [];
        const waits: RequestWaitOptions[] = [];
        let closed = false;

        const driver: TabDriver = {
            tabs: async () => [
                { id: "tab-spotify", url: "https://open.spotify.com/collection/tracks", title: "Liked Songs" },
            ],
            evaluate: async (_tabId, source, options) => {
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

                if (source.includes("queryArtistOverview")) {
                    deadlines.push(options?.deadlineMs);

                    return artistResult;
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

        return { driver, evaluated, deadlines, waits, isClosed: () => closed };
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

    // The page catches what throws, not what it builds wrong. Checking the whole artist list at
    // once made one track without a name discard every artist: "the artist harvest returned nothing".
    test("a malformed artist becomes that artist's error, and the valid ones are kept", async () => {
        const good = (uri: string) => ({
            uri,
            name: uri,
            topTracks: [{ uri: `${uri}:t`, name: "Hit", playcount: 5, albumUri: null, cover: null }],
            popularReleases: [],
        });
        const broken = {
            ...good("spotify:artist:Broken"),
            topTracks: [{ uri: "spotify:track:x", playcount: 5, albumUri: null, cover: null }],
        };
        const f = fake({
            artistResult: {
                requested: 4,
                fetched: 3,
                errors: [{ uri: "spotify:artist:Gone", error: "404 not found" }],
                artists: [good("spotify:artist:A"), broken, good("spotify:artist:B")],
            },
        });
        const uris = ["spotify:artist:A", "spotify:artist:Broken", "spotify:artist:B", "spotify:artist:Gone"];

        const result = await autoHarvestArtists({
            browserUrl: "http://127.0.0.1:9222",
            onLog: () => {},
            driver: f.driver,
            artistUris: uris,
        });

        expect(result.artists.map((a) => a.uri)).toEqual(["spotify:artist:A", "spotify:artist:B"]);
        expect(result.fetched).toBe(2);
        expect(result.errors[0]).toEqual({ uri: "spotify:artist:Gone", error: "404 not found" });
        expect(result.errors[1]?.uri).toBe("spotify:artist:Broken");
        expect(result.errors[1]?.error).toStartWith("malformed artist data at topTracks.0.name:");
        // The evaluation waits as long as the payload's own pacing can take for this many artists.
        expect(f.deadlines).toEqual([artistHarvestBudgetMs(uris.length)]);
    });
});
