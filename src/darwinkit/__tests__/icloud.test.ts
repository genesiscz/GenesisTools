import { describe, expect, it } from "bun:test";
import { runDarwinKit, runDarwinKitRaw } from "./helpers";

describe("darwinkit iCloud commands", () => {
    describe("icloud-status", () => {
        it("returns availability info", async () => {
            const result = await runDarwinKit("icloud-status");
            expect(result).toHaveProperty("available");
            expect(result).toHaveProperty("container_url");
        });
    });

    describe("icloud-start-monitoring", () => {
        it("returns ok", async () => {
            const result = await runDarwinKit("icloud-start-monitoring");
            expect(result.ok).toBe(true);
        });
    });

    describe("icloud-stop-monitoring", () => {
        it("returns ok", async () => {
            const result = await runDarwinKit("icloud-stop-monitoring");
            expect(result.ok).toBe(true);
        });
    });

    describe("icloud-read", () => {
        it("errors for nonexistent file", async () => {
            const { exitCode } = await runDarwinKitRaw("icloud-read", "/nonexistent-file-abc123.txt");
            expect(exitCode).toBe(1);
        });
    });
});
