import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { execTool, getOutput } from "@app/utils/e2e/helpers";
import { tmpPath } from "@app/utils/paths";

const ZERO_BYTE_MP3 = tmpPath("e2e-empty.mp3");
const UNSUPPORTED_FILE = tmpPath("e2e-test.xyz");

describe("tools transcribe", () => {
    afterAll(() => {
        if (existsSync(ZERO_BYTE_MP3)) {
            unlinkSync(ZERO_BYTE_MP3);
        }
    });

    describe("help", () => {
        it("--help exits 0 and shows description", async () => {
            const r = await execTool(["transcribe", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Transcribe audio");
        });

        it("--help shows all options", async () => {
            const r = await execTool(["transcribe", "--help"]);
            for (const flag of ["--provider", "--local", "--format", "--lang", "--model", "--output", "--clipboard"]) {
                expect(r.stdout).toContain(flag);
            }
        });
    });

    describe("error handling", () => {
        it("nonexistent file exits 1", async () => {
            const r = await execTool(["transcribe", "/nonexistent/path.mp3", "--provider", "local-hf"]);
            expect(r.exitCode).toBe(1);
            expect(getOutput(r).toLowerCase()).toContain("not found");
        });

        it("unsupported extension exits 1", async () => {
            writeFileSync(UNSUPPORTED_FILE, "fake");
            try {
                const r = await execTool(["transcribe", UNSUPPORTED_FILE, "--provider", "local-hf"]);
                expect(r.exitCode).toBe(1);
                expect(getOutput(r).toLowerCase()).toContain("unsupported");
            } finally {
                unlinkSync(UNSUPPORTED_FILE);
            }
        });

        it("zero-byte mp3 exits 1", async () => {
            writeFileSync(ZERO_BYTE_MP3, "");
            const r = await execTool(["transcribe", ZERO_BYTE_MP3, "--provider", "local-hf"]);
            expect(r.exitCode).toBe(1);
        });
    });
});
