import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { extractJson, runTool } from "@app/utils/e2e/helpers";

const OUTPUT_FILE = "/tmp/yt-e2e-test.txt";

describe("tools youtube", () => {
    afterAll(() => {
        if (existsSync(OUTPUT_FILE)) {
            unlinkSync(OUTPUT_FILE);
        }
    });

    describe("help", () => {
        it("--help exits 0", async () => {
            const r = await runTool(["youtube", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("YouTube");
        });

        it("transcribe --help exits 0 and shows options", async () => {
            const r = await runTool(["youtube", "transcribe", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Transcribe a YouTube video");
            for (const flag of ["--force-transcribe", "--format", "--lang", "--provider", "--output"]) {
                expect(r.stdout).toContain(flag);
            }
        });
    });

    describe("transcribe with captions", () => {
        it("fetches captions as text", async () => {
            const r = await runTool(["youtube", "transcribe", "dQw4w9WgXcQ"]);
            expect(r.exitCode).toBe(0);
            const output = r.stdout.toLowerCase();
            expect(output).toMatch(/never gonna|give you up|rick/i);
        }, 30_000);

        it("fetches captions as SRT", async () => {
            const r = await runTool(["youtube", "transcribe", "dQw4w9WgXcQ", "--format", "srt"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("-->");
            expect(r.stdout).toMatch(/^\d+\n/m);
        }, 30_000);

        it("fetches captions as VTT", async () => {
            const r = await runTool(["youtube", "transcribe", "dQw4w9WgXcQ", "--format", "vtt"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("WEBVTT");
        }, 30_000);

        it("fetches captions as JSON", async () => {
            const r = await runTool(["youtube", "transcribe", "dQw4w9WgXcQ", "--format", "json"]);
            expect(r.exitCode).toBe(0);
            const parsed = extractJson<Record<string, unknown>>(r.stdout);
            expect(parsed).toHaveProperty("text");
            expect(parsed).toHaveProperty("segments");
        }, 30_000);

        it("accepts --lang flag", async () => {
            const r = await runTool(["youtube", "transcribe", "dQw4w9WgXcQ", "--lang", "en"]);
            expect(r.exitCode).toBe(0);
        }, 30_000);
    });

    describe("output to file", () => {
        it("writes output to file", async () => {
            const r = await runTool(["youtube", "transcribe", "dQw4w9WgXcQ", "-o", OUTPUT_FILE]);
            expect(r.exitCode).toBe(0);
            expect(existsSync(OUTPUT_FILE)).toBe(true);
            const content = readFileSync(OUTPUT_FILE, "utf-8");
            expect(content.length).toBeGreaterThan(0);
        }, 30_000);
    });

    describe("error handling", () => {
        it("invalid video ID shows error", async () => {
            const r = await runTool(["youtube", "transcribe", "xxxxxxxxxxxxxxxxxxx"]);
            expect(r.exitCode).toBe(1);
        }, 15_000);
    });
});
