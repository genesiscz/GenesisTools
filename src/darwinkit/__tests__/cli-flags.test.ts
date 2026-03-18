import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { runDarwinKitRaw } from "./helpers";

describe("darwinkit CLI flags", () => {
    describe("--help", () => {
        it("shows help with command list", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw("--help");
            expect(exitCode).toBe(0);
            expect(stdout).toContain("detect-language");
            expect(stdout).toContain("sentiment");
            expect(stdout).toContain("ocr");
            expect(stdout).toContain("capabilities");
        });

        it("shows subcommand help", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw("sentiment", "--help");
            expect(exitCode).toBe(0);
            expect(stdout).toContain("text");
        });
    });

    describe("--version", () => {
        it("shows version", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw("--version");
            expect(exitCode).toBe(0);
            expect(stdout).toMatch(/^\d+\.\d+\.\d+$/);
        });
    });

    describe("--format", () => {
        it("json format outputs valid JSON", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw("sentiment", "Great!", "--format", "json");
            expect(exitCode).toBe(0);
            const parsed = SafeJSON.parse(stdout, { unbox: true });
            expect(parsed).toHaveProperty("label");
            expect(parsed).toHaveProperty("score");
        });

        it("pretty format outputs key-value pairs, not JSON braces", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw("sentiment", "Great!", "--format", "pretty");
            expect(exitCode).toBe(0);
            expect(stdout).not.toContain("{");
            expect(stdout).toContain("label:");
            expect(stdout).toContain("score:");
        });

        it("raw format outputs simplified output", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw("sentiment", "Great!", "--format", "raw");
            expect(exitCode).toBe(0);
            expect(stdout.length).toBeGreaterThan(0);
        });
    });

    describe("string[] comma splitting", () => {
        it("comma-separated --items are split into separate items", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw(
                "batch-sentiment",
                "--items",
                "I love this,I hate that,It is okay",
                "--format",
                "json"
            );
            expect(exitCode).toBe(0);
            const parsed = SafeJSON.parse(stdout, { unbox: true });
            expect(parsed).toBeArray();
            expect(parsed.length).toBe(3);
        });

        it("comma-separated --schemes are split correctly", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw(
                "tag",
                "Apple is great",
                "--schemes",
                "lemma,nameType",
                "--format",
                "json"
            );
            expect(exitCode).toBe(0);
            const parsed = SafeJSON.parse(stdout, { unbox: true });
            const schemes = new Set(parsed.tokens.map((t: { scheme: string }) => t.scheme));
            expect(schemes.has("lemma")).toBe(true);
            expect(schemes.has("nameType")).toBe(true);
        });

        it("comma-separated --categories are split correctly", async () => {
            const { stdout, exitCode } = await runDarwinKitRaw(
                "classify",
                "Goal scored!",
                "--categories",
                "finance,sports,technology",
                "--format",
                "json"
            );
            expect(exitCode).toBe(0);
            const parsed = SafeJSON.parse(stdout, { unbox: true });
            expect(parsed.scores.length).toBe(3);
        });
    });
});
