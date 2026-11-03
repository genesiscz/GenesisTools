import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, parseContentRange, partFileFor } from "./download-file";

const BODY = new Uint8Array(Array.from({ length: 300_000 }, (_, index) => index % 251));
const ranges: (string | null)[] = [];
let stalls = 0;
let wrongStarts = 0;

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const range = request.headers.get("range");
        ranges.push(range);
        const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
        const path = new URL(request.url).pathname;

        if (path === "/stall" && stalls > 0) {
            stalls--;
            // Headers arrive, then the body never sends a byte.
            return new Response(new ReadableStream({ start() {} }), {
                headers: { "content-length": String(BODY.length) },
            });
        }

        if (path === "/wrong-start" && range && wrongStarts > 0) {
            wrongStarts--;
            return new Response(BODY.slice(0), {
                status: 206,
                headers: { "content-range": `bytes 0-${BODY.length - 1}/${BODY.length}` },
            });
        }

        if (range && start >= BODY.length) {
            return new Response(null, { status: 416, headers: { "content-range": `bytes */${BODY.length}` } });
        }

        if (path === "/no-range" || !range) {
            return new Response(BODY, { headers: { "content-length": String(BODY.length) } });
        }

        return new Response(BODY.slice(start), {
            status: 206,
            headers: { "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` },
        });
    },
});

afterAll(() => server.stop(true));

describe("parseContentRange", () => {
    it("reads the start and the total, and a 416's total alone", () => {
        expect(parseContentRange("bytes 100-199/1234")).toEqual({ start: 100, total: 1234 });
        expect(parseContentRange(`bytes */1234`)).toEqual({ start: null, total: 1234 });
        expect(parseContentRange(null)).toEqual({ start: null, total: null });
    });
});

describe("downloadFile", () => {
    it("starts over when a 416 names another length than the part holds", async () => {
        const dir = mkdtempSync(join(tmpdir(), "download-file-"));
        const output = join(dir, "video.mp4");
        // Larger than the file: the server answers 416 with the real total, which is not the part's size.
        writeFileSync(partFileFor(output), new Uint8Array(BODY.length + 10).fill(9));

        const result = await downloadFile({ url: `http://localhost:${server.port}/v`, headers: {}, output });

        expect(result.complete).toBe(true);
        expect(new Uint8Array(readFileSync(output))).toEqual(BODY);
    });

    it("accepts a 416 as complete only when the part holds exactly the total", async () => {
        const dir = mkdtempSync(join(tmpdir(), "download-file-"));
        const output = join(dir, "video.mp4");
        writeFileSync(partFileFor(output), BODY);
        ranges.length = 0;

        const result = await downloadFile({ url: `http://localhost:${server.port}/v`, headers: {}, output });

        expect(ranges).toEqual([`bytes=${BODY.length}-`]);
        expect(result).toMatchObject({ complete: true, bytes: BODY.length });
    });

    it("starts over when a 206 resumes at another byte than asked", async () => {
        const dir = mkdtempSync(join(tmpdir(), "download-file-"));
        const output = join(dir, "video.mp4");
        writeFileSync(partFileFor(output), BODY.slice(0, 1000));
        wrongStarts = 1;

        const result = await downloadFile({ url: `http://localhost:${server.port}/wrong-start`, headers: {}, output });

        expect(result.complete).toBe(true);
        expect(new Uint8Array(readFileSync(output))).toEqual(BODY);
    });

    it("drops an attempt that stalls and resumes it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "download-file-"));
        const output = join(dir, "video.mp4");
        stalls = 1;

        const result = await downloadFile({
            url: `http://localhost:${server.port}/stall`,
            headers: {},
            output,
            idleTimeoutMs: 50,
            retryDelayMs: 1,
        });

        expect(stalls).toBe(0);
        expect(result.complete).toBe(true);
        expect(new Uint8Array(readFileSync(output))).toEqual(BODY);
    });

    it("resumes a part file with a range request and renames it when complete", async () => {
        const dir = mkdtempSync(join(tmpdir(), "download-file-"));
        const output = join(dir, "video.mp4");
        writeFileSync(partFileFor(output), BODY.slice(0, 120_000));
        ranges.length = 0;

        const result = await downloadFile({ url: `http://localhost:${server.port}/v`, headers: {}, output });

        expect(ranges).toEqual(["bytes=120000-"]);
        expect(result).toMatchObject({ complete: true, bytes: BODY.length, total: BODY.length, resumedFrom: 120_000 });
        expect(new Uint8Array(readFileSync(output))).toEqual(BODY);
        expect(existsSync(partFileFor(output))).toBe(false);
    });

    it("starts over when the server ignores the range", async () => {
        const dir = mkdtempSync(join(tmpdir(), "download-file-"));
        const output = join(dir, "video.mp4");
        writeFileSync(partFileFor(output), new Uint8Array(50_000).fill(7));

        await downloadFile({ url: `http://localhost:${server.port}/no-range`, headers: {}, output });

        expect(new Uint8Array(readFileSync(output))).toEqual(BODY);
    });
});
