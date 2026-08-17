/**
 * The `play run` loop, driven against a fake MCP session.
 *
 * This is the largest piece of the tool that a real run is the only other way to reach: it
 * needs a browser, a Spotify account, and it takes over playback, so in practice it was
 * never exercised at all. The interesting behaviour is not the browser — it is the loop:
 * what gets queued, what gets skipped on resume, what happens when a track fails, and
 * whether the journal and the summary agree afterwards.
 *
 * The fake answers each tool call the way chrome-devtools-mcp does, so the payload strings
 * are matched exactly as the real thing would see them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { playDir } from "@app/spotify/lib/paths";
import { runPreview } from "@app/spotify/lib/play/driver";
import { progressFor } from "@app/spotify/lib/play/journal";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Client } from "@modelcontextprotocol/client";

/** chrome-devtools-mcp wraps every result in a text content block. */
const reply = (value: unknown) => ({
    content: [{ type: "text", text: `\`\`\`json\n${SafeJSON.stringify(value)}\n\`\`\`` }],
});
const plain = (text: string) => ({ content: [{ type: "text", text }] });

interface FakeOptions {
    /** Make every volume setter fail, as an unknown web-player build would. */
    noVolumeSetter?: boolean;
    /** Fail SAMPLE for these track URIs. */
    failSampleFor?: string[];
    /** Fail SKIP_NEXT the first N times it is called. */
    failSkips?: number;
    /** Report no Spotify tab at all. */
    noTab?: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
    const calls: { name: string; fn?: string }[] = [];
    let skipFailures = opts.failSkips ?? 0;
    let current = "";
    let navigated = false;

    const client = {
        callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
            const fn = typeof args?.function === "string" ? args.function : undefined;
            calls.push({ name, fn });

            if (name === "list_pages") {
                return opts.noTab
                    ? plain("## Pages\n1: chrome://newtab/")
                    : plain("## Pages\n1: https://open.spotify.com/");
            }

            if (name === "navigate_page") {
                navigated = true;

                return plain("ok");
            }

            if (name === "select_page") {
                return plain("ok");
            }

            if (name === "evaluate_script" && fn) {
                if (fn.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) {
                    // No Spotify tab means no player either — the payload would be evaluated
                    // against whatever page IS selected. Once `navigate_page` has opened one,
                    // the player is there. Modelling this honestly is what makes the recovery
                    // branch reachable at all.
                    if (opts.noTab && !navigated) {
                        return reply({ ok: false, error: "playerAPI not found in fiber tree" });
                    }

                    return reply({ ok: true, cached: false });
                }

                if (fn.includes("pages: [{ items:")) {
                    const uris = [...fn.matchAll(/spotify:track:[a-z0-9]+/g)].map((m) => m[0]);
                    current = uris[0] ?? "";

                    return reply({ ok: true, queued: uris.length, track: "queued" });
                }

                if (fn.includes("volume-bar")) {
                    return opts.noVolumeSetter
                        ? reply({ ok: false, error: "the volume slider did not move" })
                        : reply({ ok: true, how: "volume slider", before: 0.8, after: 0.1, step: "0.1" });
                }

                if (fn.includes("skipToNext")) {
                    if (skipFailures > 0) {
                        skipFailures--;

                        return reply({ ok: false, error: "skipToNext threw: no next track" });
                    }

                    return reply({ ok: true, track: "next" });
                }

                if (fn.includes("api.play({ uri:")) {
                    current = /spotify:track:[a-z0-9]+/.exec(fn)?.[0] ?? "";

                    return reply({ ok: true });
                }

                if (fn.includes("const windows =")) {
                    if (opts.failSampleFor?.includes(current)) {
                        return reply({ ok: false, error: "playback never started" });
                    }

                    return reply({ ok: true, track: "Song — Artist", heard: ["0:10→0:13"], missed: 0 });
                }
            }

            return plain("");
        },
    } as unknown as Client;

    return {
        calls,
        withClient: <T>(fn: (c: Client) => Promise<T>) => fn(client),
        /** Advances `current` the way a real queued run does, so SAMPLE sees the right track. */
        setCurrent: (uri: string) => {
            current = uri;
        },
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

const run = (fake: ReturnType<typeof fakeClient>, over: Partial<Parameters<typeof runPreview>[0]> = {}) =>
    runPreview({
        tracksFile,
        windows: [[10, 3]],
        queue: true,
        betweenMs: 0,
        start: 0,
        resume: false,
        browserUrl: "http://127.0.0.1:9222",
        onLog: () => {},
        withClient: fake.withClient,
        ...over,
    });

describe("play run", () => {
    test("plays every track and journals each one", async () => {
        const fake = fakeClient();
        const result = await run(fake);

        expect(result).toEqual({ total: 3, ok: 3, failed: [], aborted: false });
        expect(progressFor(tracksFile).okIndexes.size).toBe(3);
    });

    test("loads the queue once, then steps with skipToNext", async () => {
        const fake = fakeClient();
        await run(fake);

        const evaluated = fake.calls.filter((c) => c.name === "evaluate_script");
        expect(evaluated.filter((c) => c.fn?.includes("pages: [{ items:"))).toHaveLength(1);
        // Three tracks, positioned on the first: two steps.
        expect(evaluated.filter((c) => c.fn?.includes("skipToNext"))).toHaveLength(2);
    });

    test("--no-queue plays each track standalone instead", async () => {
        const fake = fakeClient();
        await run(fake, { queue: false });

        const evaluated = fake.calls.filter((c) => c.name === "evaluate_script");
        expect(evaluated.filter((c) => c.fn?.includes("pages: [{ items:"))).toHaveLength(0);
        expect(evaluated.filter((c) => c.fn?.includes("api.play({ uri:"))).toHaveLength(3);
    });

    test("--start and --end select a slice", async () => {
        const fake = fakeClient();
        const result = await run(fake, { start: 1, end: 1 });

        expect(result.total).toBe(1);
        expect(result.ok).toBe(1);
    });

    test("--resume skips what the journal already marks done", async () => {
        const first = await run(fakeClient(), { end: 0 });
        expect(first.ok).toBe(1);

        const second = await run(fakeClient(), { resume: true });
        // Two left of three.
        expect(second.total).toBe(2);
        expect(second.ok).toBe(2);
    });

    // The failure has to reach BOTH the summary and the journal, or `play status` reports a
    // clean run while the summary counts a failure.
    test("a failed sample is counted and journalled", async () => {
        const fake = fakeClient({ failSampleFor: ["spotify:track:aaa"] });
        const result = await run(fake, { queue: false });

        expect(result.ok).toBe(2);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]).toContain("A");

        const progress = progressFor(tracksFile);
        expect(progress.failed).toBe(1);
        expect(progress.okIndexes.has(0)).toBe(false);
    });

    test("a failed skipToNext is journalled too, not just counted", async () => {
        const fake = fakeClient({ failSkips: 1 });
        const result = await run(fake);

        expect(result.failed).toHaveLength(1);
        expect(progressFor(tracksFile).failed).toBe(1);
    });

    // With no Spotify tab the run must not give up: it navigates one open and carries on.
    // The assertion is that it RECOVERS, which is the whole point of that branch.
    test("no Spotify tab is recovered by opening one, not an abort", async () => {
        const fake = fakeClient({ noTab: true });
        const result = await run(fake);

        expect(fake.calls.some((c) => c.name === "navigate_page")).toBe(true);
        expect(result.aborted).toBe(false);
        expect(result.ok).toBe(3);
    });

    test("an empty selection does nothing and connects to nothing", async () => {
        const fake = fakeClient();
        const result = await run(fake, { start: 99 });

        expect(result).toEqual({ total: 0, ok: 0, failed: [], aborted: false });
        expect(fake.calls).toHaveLength(0);
    });
});

describe("play run --volume", () => {
    // The feature exists because previewing happens while doing something else: the first
    // real request for this run was "make the audio 1% volume, I am watching a video".
    test("sets the volume BEFORE the queue loads, since loading it starts playback", async () => {
        const fake = fakeClient();
        await run(fake, { volume: 0.01 });

        const evaluated = fake.calls.filter((c) => c.name === "evaluate_script").map((c) => c.fn ?? "");
        const volumeAt = evaluated.findIndex((f) => f.includes("volume-bar"));
        const queueAt = evaluated.findIndex((f) => f.includes("pages: [{ items:"));

        expect(volumeAt).toBeGreaterThanOrEqual(0);
        expect(volumeAt).toBeLessThan(queueAt);
    });

    test("restores the previous volume when the run finishes", async () => {
        const fake = fakeClient();
        await run(fake, { volume: 0.01 });

        const sets = fake.calls.filter((c) => c.fn?.includes("volume-bar"));
        // Once to lower it, once to put it back.
        expect(sets.length).toBe(2);
        expect(sets.at(-1)?.fn).toContain("0.8");
    });

    // Proceeding quietly here would mean playing at whatever the volume already was, which
    // is the exact surprise the flag exists to prevent.
    test("aborts rather than playing when the volume cannot be set", async () => {
        const fake = fakeClient({ noVolumeSetter: true });
        const result = await run(fake, { volume: 0.01 });

        expect(result.aborted).toBe(true);
        expect(result.ok).toBe(0);
        expect(fake.calls.some((c) => c.fn?.includes("pages: [{ items:"))).toBe(false);
    });

    test("no --volume touches the volume at all", async () => {
        const fake = fakeClient();
        await run(fake);

        expect(fake.calls.some((c) => c.fn?.includes("volume-bar"))).toBe(false);
    });
});
