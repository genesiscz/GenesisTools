import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { getOutput, runTool } from "@app/utils/e2e/helpers";

const ZERO_BYTE_MP3 = "/tmp/e2e-empty.mp3";

describe("tools transcribe", () => {
    afterAll(() => {
        if (existsSync(ZERO_BYTE_MP3)) {
            unlinkSync(ZERO_BYTE_MP3);
        }
    });

    describe("help", () => {
        it("--help exits 0 and shows description", async () => {
            const r = await runTool(["transcribe", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Transcribe audio");
        });

        it("--help shows all options", async () => {
            const r = await runTool(["transcribe", "--help"]);
            for (const flag of ["--provider", "--local", "--format", "--lang", "--model", "--output", "--clipboard"]) {
                expect(r.stdout).toContain(flag);
            }
        });
    });

    describe("error handling", () => {
        it("nonexistent file exits 1", async () => {
            const r = await runTool(["transcribe", "/nonexistent/path.mp3"]);
            expect(r.exitCode).toBe(1);
            expect(getOutput(r).toLowerCase()).toContain("not found");
        });

        it("unsupported extension exits 1", async () => {
            writeFileSync("/tmp/e2e-test.xyz", "fake");
            try {
                const r = await runTool(["transcribe", "/tmp/e2e-test.xyz"]);
                expect(r.exitCode).toBe(1);
                expect(getOutput(r).toLowerCase()).toContain("unsupported");
            } finally {
                unlinkSync("/tmp/e2e-test.xyz");
            }
        });

        it("zero-byte mp3 exits 1", async () => {
            writeFileSync(ZERO_BYTE_MP3, "");
            const r = await runTool(["transcribe", ZERO_BYTE_MP3]);
            expect(r.exitCode).toBe(1);
        });
    });
});
