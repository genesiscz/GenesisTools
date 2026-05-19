import { describe, expect, it } from "bun:test";
import { execTool } from "@app/utils/e2e/helpers";

describe("tools ai", () => {
    describe("help", () => {
        it("--help exits 0 and shows description", async () => {
            const r = await execTool(["ai", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout.toLowerCase()).toContain("ai toolkit");
        });

        it("translate --help exits 0", async () => {
            const r = await execTool(["ai", "translate", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Translate");
            for (const flag of ["--from", "--to", "--provider"]) {
                expect(r.stdout).toContain(flag);
            }
        });

        it("summarize --help exits 0", async () => {
            const r = await execTool(["ai", "summarize", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Summarize");
        });

        it("classify --help exits 0", async () => {
            const r = await execTool(["ai", "classify", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Classify");
            expect(r.stdout).toContain("--categories");
        });

        it("models --help exits 0", async () => {
            const r = await execTool(["ai", "models", "--help"]);
            expect(r.exitCode).toBe(0);
        });

        it("config --help exits 0", async () => {
            const r = await execTool(["ai", "config", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Configure");
        });
    });
});
