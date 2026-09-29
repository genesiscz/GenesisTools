/**
 * The `play run` loop, driven against a fake browser.
 *
 * This is the largest piece of the tool that a real run is the only other way to reach: it
 * needs a browser, a Spotify account, and it takes over playback, so in practice it was
 * never exercised at all. The interesting behaviour is not the browser — it is the loop:
 * what gets queued, what gets skipped on resume, what happens when a track fails, and
 * whether the journal and the summary agree afterwards.
 *
 * The fake is a `TabDriver` that answers each evaluated payload by value, the way the CDP
 * driver does, so the payload strings are matched exactly as the page would see them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TabDriver } from "@app/chrome-devtools/lib/tab-driver";
import type { TabInfo } from "@app/chrome-devtools/lib/tabs";
import { playDir } from "@app/spotify/lib/paths";
import { runPreview, sampleDeadlineMs } from "@app/spotify/lib/play/driver";
import { progressFor } from "@app/spotify/lib/play/journal";
import { SafeJSON } from "@genesiscz/utils/json";

interface FakeOptions {
    /** Make every volume setter fail, as an unknown web-player build would. */
    noVolumeSetter?: boolean;
    /** Fail SAMPLE for these track URIs. */
    failSampleFor?: string[];
    /** Make SAMPLE throw in the page for these track URIs. */
    throwSampleFor?: string[];
    /** Fail SKIP_NEXT the first N times it is called. */
    failSkips?: number;
    /** Report no Spotify tab at all until one is opened. */
    noTab?: boolean;
}

interface FakeCall {
    method: "tabs" | "evaluate" | "navigate" | "open" | "waitForRequest" | "close";
    source?: string;
    url?: string;
    deadlineMs?: number;
}

const SPOTIFY_TAB: TabInfo = { id: "tab-spotify", url: "https://open.spotify.com/", title: "Spotify" };
const NEW_TAB: TabInfo = { id: "tab-newtab", url: "chrome://newtab/", title: "New Tab" };

function fakeDriver(opts: FakeOptions = {}) {
    const calls: FakeCall[] = [];
    let skipFailures = opts.failSkips ?? 0;
    let current = "";
    let opened = false;

    const answer = (fn: string): unknown => {
        if (fn.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) {
            return { ok: true, cached: false };
        }

        if (fn.includes("pages: [{ items:")) {
            const uris = [...fn.matchAll(/spotify:track:[a-z0-9]+/g)].map((m) => m[0]);
            current = uris[0] ?? "";

            return { ok: true, queued: uris.length, track: "queued" };
        }

        if (fn.includes("volume-bar")) {
            return opts.noVolumeSetter
                ? { ok: false, error: "the volume slider did not move" }
                : { ok: true, how: "volume slider", before: 0.8, after: 0.1, step: "0.1" };
        }

        if (fn.includes("skipToNext")) {
            if (skipFailures > 0) {
                skipFailures--;

                return { ok: false, error: "skipToNext threw: no next track" };
            }

            return { ok: true, track: "next" };
        }

        if (fn.includes("api.play({ uri:")) {
            current = /spotify:track:[a-z0-9]+/.exec(fn)?.[0] ?? "";

            return { ok: true };
        }

        if (fn.includes("const windows =")) {
            if (opts.throwSampleFor?.includes(current)) {
                throw new Error("Uncaught TypeError: api.seekTo is not a function");
            }

            if (opts.failSampleFor?.includes(current)) {
                return { ok: false, error: "playback never started" };
            }

            return { ok: true, track: "Song — Artist", heard: ["0:10→0:13"], missed: 0 };
        }

        return undefined;
    };

    const driver: TabDriver = {
        tabs: async () => {
            calls.push({ method: "tabs" });

            return opts.noTab && !opened ? [NEW_TAB] : [SPOTIFY_TAB];
        },
        evaluate: async (_tabId, source, options) => {
            calls.push({ method: "evaluate", source, deadlineMs: options?.deadlineMs });

            return answer(source);
        },
        navigate: async (_tabId, url) => {
            calls.push({ method: "navigate", url });

            return true;
        },
        open: async (url) => {
            calls.push({ method: "open", url });
            opened = true;

            return { ...SPOTIFY_TAB, url };
        },
        waitForRequest: async () => {
            calls.push({ method: "waitForRequest" });

            return { request: null, seen: [] };
        },
        close: () => {
            calls.push({ method: "close" });
        },
    };

    return {
        calls,
        driver,
        evaluated: () => calls.filter((c) => c.method === "evaluate").map((c) => c.source ?? ""),
    };
}

const TRACKS = [
    { uri: "spotify:track:aaa", name: "A" },
    { uri: "spotify:track:bbb", name: "B" },
    { uri: "spotify:track:ccc", name: "C" },
];

let tracksFile = "";

beforeEach(() => {
    rmSync(playDir(), { recursive: true, force: true });
    mkdirSync(playDir(), { recursive: true });
    tracksFile = join(playDir(), "tracks.json");
    writeFileSync(tracksFile, SafeJSON.stringify(TRACKS));
});

afterEach(() => {
    rmSync(playDir(), { recursive: true, force: true });
});

const run = (fake: ReturnType<typeof fakeDriver>, over: Partial<Parameters<typeof runPreview>[0]> = {}) =>
    runPreview({
        tracksFile,
        windows: [[10, 3]],
        queue: true,
        betweenMs: 0,
        start: 0,
        resume: false,
        browserUrl: "http://127.0.0.1:9222",
        onLog: () => {},
        driver: fake.driver,
        ...over,
    });

describe("play run", () => {
    test("plays every track and journals each one", async () => {
        const fake = fakeDriver();
        const result = await run(fake);

        expect(result).toEqual({ total: 3, ok: 3, failed: [], aborted: false });
        expect(progressFor(tracksFile).okIndexes.size).toBe(3);
    });

    test("loads the queue once, then steps with skipToNext", async () => {
        const fake = fakeDriver();
        await run(fake);

        const evaluated = fake.evaluated();
        expect(evaluated.filter((f) => f.includes("pages: [{ items:"))).toHaveLength(1);
        // Three tracks, positioned on the first: two steps.
        expect(evaluated.filter((f) => f.includes("skipToNext"))).toHaveLength(2);
    });

    test("--no-queue plays each track standalone instead", async () => {
        const fake = fakeDriver();
        await run(fake, { queue: false });

        const evaluated = fake.evaluated();
        expect(evaluated.filter((f) => f.includes("pages: [{ items:"))).toHaveLength(0);
        expect(evaluated.filter((f) => f.includes("api.play({ uri:"))).toHaveLength(3);
    });

    test("--start and --end select a slice", async () => {
        const fake = fakeDriver();
        const result = await run(fake, { start: 1, end: 1 });

        expect(result.total).toBe(1);
        expect(result.ok).toBe(1);
    });

    test("--resume skips what the journal already marks done", async () => {
        const first = await run(fakeDriver(), { end: 0 });
        expect(first.ok).toBe(1);

        const second = await run(fakeDriver(), { resume: true });
        // Two left of three.
        expect(second.total).toBe(2);
        expect(second.ok).toBe(2);
    });

    // The failure has to reach BOTH the summary and the journal, or `play status` reports a
    // clean run while the summary counts a failure.
    test("a failed sample is counted and journalled", async () => {
        const fake = fakeDriver({ failSampleFor: ["spotify:track:aaa"] });
        const result = await run(fake, { queue: false });

        expect(result.ok).toBe(2);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]).toContain("A");

        const progress = progressFor(tracksFile);
        expect(progress.failed).toBe(1);
        expect(progress.okIndexes.has(0)).toBe(false);
    });

    // A page error rejects the evaluation; the loop must see it as a failed track, not die.
    test("a page error in the sample is a journalled failure and the run carries on", async () => {
        const fake = fakeDriver({ throwSampleFor: ["spotify:track:aaa"] });
        const result = await run(fake, { queue: false });

        expect(result.aborted).toBe(false);
        expect(result.ok).toBe(2);
        expect(result.failed[0]).toContain("api.seekTo is not a function");
        expect(progressFor(tracksFile).failed).toBe(1);
    });

    test("the sample gets a deadline that fits its windows", async () => {
        const fake = fakeDriver();
        await run(fake, { windows: [[10, 30]] });

        const samples = fake.calls.filter((c) => c.source?.includes("const windows ="));
        expect(samples).toHaveLength(3);
        expect(samples.every((c) => c.deadlineMs === sampleDeadlineMs([[10, 30]]))).toBe(true);
        expect(sampleDeadlineMs([[10, 30]])).toBeGreaterThan(30_000);
    });

    test("a failed skipToNext is journalled too, not just counted", async () => {
        const fake = fakeDriver({ failSkips: 1 });
        const result = await run(fake);

        expect(result.failed).toHaveLength(1);
        expect(progressFor(tracksFile).failed).toBe(1);
    });

    // With no Spotify tab the run must not give up: it opens one and carries on. It opens a
    // NEW tab rather than navigating one, so the user's own page is never taken over.
    test("no Spotify tab is recovered by opening a new one, not an abort", async () => {
        const fake = fakeDriver({ noTab: true });
        const result = await run(fake);

        expect(fake.calls.some((c) => c.method === "open")).toBe(true);
        expect(fake.calls.some((c) => c.method === "navigate")).toBe(false);
        expect(result.aborted).toBe(false);
        expect(result.ok).toBe(3);
    });

    test("an empty selection does nothing and connects to nothing", async () => {
        const fake = fakeDriver();
        const result = await run(fake, { start: 99 });

        expect(result).toEqual({ total: 0, ok: 0, failed: [], aborted: false });
        expect(fake.calls).toHaveLength(0);
    });

    test("a passed-in driver is left open for its owner", async () => {
        const fake = fakeDriver();
        await run(fake);

        expect(fake.calls.some((c) => c.method === "close")).toBe(false);
    });
});

describe("play run --volume", () => {
    // The feature exists because previewing happens while doing something else: the first
    // real request for this run was "make the audio 1% volume, I am watching a video".
    test("sets the volume BEFORE the queue loads, since loading it starts playback", async () => {
        const fake = fakeDriver();
        await run(fake, { volume: 0.01 });

        const evaluated = fake.evaluated();
        const volumeAt = evaluated.findIndex((f) => f.includes("volume-bar"));
        const queueAt = evaluated.findIndex((f) => f.includes("pages: [{ items:"));

        expect(volumeAt).toBeGreaterThanOrEqual(0);
        expect(volumeAt).toBeLessThan(queueAt);
    });

    test("restores the previous volume when the run finishes", async () => {
        const fake = fakeDriver();
        await run(fake, { volume: 0.01 });

        const sets = fake.evaluated().filter((f) => f.includes("volume-bar"));
        // Once to lower it, once to put it back.
        expect(sets.length).toBe(2);
        expect(sets.at(-1)).toContain("0.8");
    });

    // Proceeding quietly here would mean playing at whatever the volume already was, which
    // is the exact surprise the flag exists to prevent.
    test("aborts rather than playing when the volume cannot be set", async () => {
        const fake = fakeDriver({ noVolumeSetter: true });
        const result = await run(fake, { volume: 0.01 });

        expect(result.aborted).toBe(true);
        expect(result.ok).toBe(0);
        expect(fake.evaluated().some((f) => f.includes("pages: [{ items:"))).toBe(false);
    });

    test("no --volume touches the volume at all", async () => {
        const fake = fakeDriver();
        await run(fake);

        expect(fake.evaluated().some((f) => f.includes("volume-bar"))).toBe(false);
    });
});
