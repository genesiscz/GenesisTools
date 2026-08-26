import { afterEach, describe, expect, test } from "bun:test";
// follow() is driven against an isolated temp dir via its dir override, so the
// test can never touch a real port's capture.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedEvent } from "./channels.ts";
import { follow, makeMatcher } from "./follow.ts";
import { SegmentWriter } from "./segments.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const fn of cleanups.splice(0)) {
        fn();
    }
});

describe("makeMatcher", () => {
    test("substring and /regex/ forms", () => {
        expect(makeMatcher("idp.example")("https://idp.example.com/x")).toBe(true);
        expect(makeMatcher("idp.example")("https://app.example.com/x")).toBe(false);
        expect(makeMatcher("/(idp|auth)\\.example/")("https://auth.example.com/")).toBe(true);
        expect(makeMatcher(undefined)("anything")).toBe(true);
    });

    test("a /pattern/g matcher stays stateless across repeated calls", () => {
        const matches = makeMatcher("/example/g");
        expect(matches("https://app.example.com/")).toBe(true);
        expect(matches("https://app.example.com/")).toBe(true);
        expect(matches("https://app.example.com/")).toBe(true);
    });
});

describe("follow across rotation", () => {
    test("renders replayed events, live appends, and hops to a rotated segment without losing lines", async () => {
        // A high fake port keeps this out of any real capture dir's way.
        const port = 59_876;
        const dir = mkdtempSync(join(tmpdir(), "cdp-follow-"));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

        const nav = (url: string, t: number): RecordedEvent => ({
            method: "Page.frameNavigated",
            params: { frame: { url } },
            sessionId: "S1",
            t,
        });

        let now = 1_000_000;
        const writer = new SegmentWriter(dir, { rotateMs: 500, maxAgeMs: 1e9, now: () => now });
        writer.write(nav("https://one.example.com/", now));

        const lines: string[] = [];
        const ac = new AbortController();
        const done = follow({
            port,
            dir,
            channels: ["nav"],
            sinceMs: 0,
            onLine: (line) => lines.push(line),
            signal: ac.signal,
            pollMs: 20,
            seconds: 5,
        });

        // live append into the SAME segment
        await Bun.sleep(80);
        writer.write(nav("https://two.example.com/", now));

        // force a rotation, then write into the NEW segment
        now += 600;
        writer.write(nav("https://three.example.com/", now));
        await Bun.sleep(150);
        writer.close();
        ac.abort();
        await done;

        const urls = lines.map((l) => l.split(" ").at(-1));
        expect(urls).toEqual(["https://one.example.com/", "https://two.example.com/", "https://three.example.com/"]);
    });
});
