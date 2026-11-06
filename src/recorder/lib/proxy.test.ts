import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import * as video from "@genesiscz/utils/video/process";
import { createCanvas } from "@napi-rs/canvas";
import { makeProxy } from "./proxy";

test("proxy retains valid audio before a truncated index row", async () => {
    const folder = mkdtempSync(join(tmpdir(), "proxy-audio-"));
    const startedAt = "2026-11-05T10:00:00.000Z";
    writeFileSync(
        join(folder, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: "fixture",
            title: "Fixture",
            startedAt,
            frames: [{ file: "frame.png", atMs: 0, displayId: 1 }],
            displays: [{ id: 1, name: "one" }],
        })
    );
    writeFileSync(join(folder, "frame.png"), createCanvas(64, 40).toBuffer("image/png"));
    writeFileSync(join(folder, "audio.m4a"), "fixture");
    writeFileSync(join(folder, "audio.jsonl"), `${SafeJSON.stringify({ file: "audio.m4a", at: startedAt })}\n{"file":`);
    const encode = spyOn(video, "runVideoCommand").mockImplementation(async (options) => {
        expect(options.command).toContain(join(folder, "audio.m4a"));
        writeFileSync(join(folder, ".proxy.partial.mp4"), "fixture output");
        return "";
    });
    try {
        expect((await makeProxy(folder)).audioPieces).toBe(1);
        expect(encode).toHaveBeenCalledTimes(1);
    } finally {
        encode.mockRestore();
    }
});

// Regression test: deep test 2026-11-06 RE14 — proxy on a movie recording said it "has no frames to make a movie of".
test("proxy on a recording that has its movie says a proxy is for frames recordings", async () => {
    const folder = mkdtempSync(join(tmpdir(), "proxy-movie-"));
    writeFileSync(join(folder, "screen.mp4"), "fixture");

    await expect(makeProxy(folder)).rejects.toThrow(
        "has its movie (screen.mp4); a proxy is only for a frames recording"
    );
});
