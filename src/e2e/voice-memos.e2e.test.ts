import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { runTool } from "./helpers";

const EXPORT_DIR = "/tmp/vm-e2e-export";

describe("tools macos voice-memos", () => {
    afterAll(async () => {
        if (existsSync(EXPORT_DIR)) {
            await rm(EXPORT_DIR, { recursive: true, force: true });
        }
    });

    describe("help", () => {
        it("--help exits 0", async () => {
            const r = await runTool(["macos", "voice-memos", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Voice Memos");
        });

        it("list --help exits 0", async () => {
            const r = await runTool(["macos", "voice-memos", "list", "--help"]);
            expect(r.exitCode).toBe(0);
        });

        it("transcribe --help exits 0 and shows all options", async () => {
            const r = await runTool(["macos", "voice-memos", "transcribe", "--help"]);
            expect(r.exitCode).toBe(0);
            for (const flag of [
                "--lang",
                "--force",
                "--all",
                "--provider",
                "--local",
                "--model",
                "--format",
                "--output",
                "--clipboard",
            ]) {
                expect(r.stdout).toContain(flag);
            }
        });

        it("export --help exits 0", async () => {
            const r = await runTool(["macos", "voice-memos", "export", "--help"]);
            expect(r.exitCode).toBe(0);
        });

        it("search --help exits 0", async () => {
            const r = await runTool(["macos", "voice-memos", "search", "--help"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("list", () => {
        it("list exits 0 and shows table headers", async () => {
            const r = await runTool(["macos", "voice-memos", "list"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("#");
            expect(r.stdout).toContain("Title");
        });
    });

    describe("search", () => {
        it("search nonexistent query exits 0", async () => {
            const r = await runTool(["macos", "voice-memos", "search", "nonexistent-query-xyz-e2e"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("export", () => {
        it("export memo 377 to temp dir", async () => {
            const r = await runTool(["macos", "voice-memos", "export", "377", EXPORT_DIR]);
            expect(r.exitCode).toBe(0);
            expect(existsSync(EXPORT_DIR)).toBe(true);
            const files = readdirSync(EXPORT_DIR);
            expect(files.length).toBeGreaterThan(0);
        });
    });

    describe("transcribe", () => {
        it("transcribe invalid ID exits 1", async () => {
            const r = await runTool(["macos", "voice-memos", "transcribe", "999999"]);
            expect(r.exitCode).toBe(1);
            const output = r.stdout + r.stderr;
            expect(output.toLowerCase()).toMatch(/no memo|not found/i);
        });

        it("transcribe --all exits 0", async () => {
            const r = await runTool(["macos", "voice-memos", "transcribe", "--all"], 60_000);
            expect(r.exitCode).toBe(0);
        }, 60_000);
    });

    describe("error handling", () => {
        it("play invalid ID exits 1", async () => {
            const r = await runTool(["macos", "voice-memos", "play", "999999"]);
            expect(r.exitCode).toBe(1);
        });
    });
});
