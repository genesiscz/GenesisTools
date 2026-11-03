import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile, partFileFor } from "./download-file";

const BODY = new Uint8Array(Array.from({ length: 300_000 }, (_, index) => index % 251));
const ranges: (string | null)[] = [];

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const range = request.headers.get("range");
        ranges.push(range);
        const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;

        if (new URL(request.url).pathname === "/no-range" || !range) {
            return new Response(BODY, { headers: { "content-length": String(BODY.length) } });
        }

        return new Response(BODY.slice(start), {
            status: 206,
            headers: { "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` },
        });
    },
});

afterAll(() => server.stop(true));

describe("downloadFile", () => {
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
