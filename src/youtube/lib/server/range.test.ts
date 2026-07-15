import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveFileWithRange } from "@app/youtube/lib/server/range";

const BODY = "0123456789".repeat(200); // 2000 bytes

let dir: string;
let filePath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "youtube-range-"));
    filePath = join(dir, "audio.mp3");
    writeFileSync(filePath, BODY);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("serveFileWithRange", () => {
    it("serves the full file with 200 + Accept-Ranges when there is no Range header", async () => {
        const res = await serveFileWithRange(new Request("http://localhost/audio"), filePath, "audio/mpeg");

        expect(res.status).toBe(200);
        expect(res.headers.get("Accept-Ranges")).toBe("bytes");
        expect(res.headers.get("Content-Length")).toBe(String(BODY.length));
        expect(await res.text()).toBe(BODY);
    });

    it("serves a 206 partial response for a bounded Range request", async () => {
        const req = new Request("http://localhost/audio", { headers: { Range: "bytes=0-1023" } });
        const res = await serveFileWithRange(req, filePath, "audio/mpeg");

        expect(res.status).toBe(206);
        expect(res.headers.get("Content-Range")).toBe(`bytes 0-1023/${BODY.length}`);
        expect(res.headers.get("Accept-Ranges")).toBe("bytes");
        expect(res.headers.get("Content-Length")).toBe("1024");
        expect(await res.text()).toBe(BODY.slice(0, 1024));
    });

    it("serves an open-ended Range (bytes=N-) through to the end", async () => {
        const req = new Request("http://localhost/audio", { headers: { Range: `bytes=${BODY.length - 10}-` } });
        const res = await serveFileWithRange(req, filePath, "audio/mpeg");

        expect(res.status).toBe(206);
        expect(res.headers.get("Content-Range")).toBe(`bytes ${BODY.length - 10}-${BODY.length - 1}/${BODY.length}`);
        expect(await res.text()).toBe(BODY.slice(-10));
    });

    it("416s on a range starting at or past the file size", async () => {
        const req = new Request("http://localhost/audio", {
            headers: { Range: `bytes=${BODY.length}-${BODY.length + 10}` },
        });
        const res = await serveFileWithRange(req, filePath, "audio/mpeg");

        expect(res.status).toBe(416);
        expect(res.headers.get("Content-Range")).toBe(`bytes */${BODY.length}`);
    });

    it("404s with a JSON error when the file doesn't exist", async () => {
        const res = await serveFileWithRange(
            new Request("http://localhost/audio"),
            join(dir, "missing.mp3"),
            "audio/mpeg"
        );

        expect(res.status).toBe(404);
        expect((await res.json()) as { error: string }).toEqual({ error: "not found" });
    });
});
