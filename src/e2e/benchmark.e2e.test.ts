import { afterAll, describe, expect, it } from "bun:test";
import { runTool } from "./helpers";

describe("tools benchmark", () => {
    afterAll(async () => {
        await runTool(["benchmark", "remove", "e2e-suite"]);
    });

    describe("help", () => {
        it("--help exits 0", async () => {
            const r = await runTool(["benchmark", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Benchmark");
        });

        it("list --help exits 0", async () => {
            const r = await runTool(["benchmark", "list", "--help"]);
            expect(r.exitCode).toBe(0);
        });

        it("add --help exits 0", async () => {
            const r = await runTool(["benchmark", "add", "--help"]);
            expect(r.exitCode).toBe(0);
        });

        it("remove --help exits 0", async () => {
            const r = await runTool(["benchmark", "remove", "--help"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("list", () => {
        it("list exits 0 and shows built-in suites", async () => {
            const r = await runTool(["benchmark", "list"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("startup");
        });
    });

    describe("suite CRUD lifecycle", () => {
        it("add, list, remove suite", async () => {
            const add = await runTool(["benchmark", "add", "e2e-suite", "a:echo hi", "b:echo bye"]);
            expect(add.exitCode).toBe(0);
            const addOut = add.stdout + add.stderr;
            expect(addOut.toLowerCase()).toMatch(/saved|added|created/i);

            const list = await runTool(["benchmark", "list"]);
            expect(list.exitCode).toBe(0);
            expect(list.stdout).toContain("e2e-suite");

            const remove = await runTool(["benchmark", "remove", "e2e-suite"]);
            expect(remove.exitCode).toBe(0);
            const removeOut = remove.stdout + remove.stderr;
            expect(removeOut.toLowerCase()).toMatch(/removed|deleted/i);

            const listAfter = await runTool(["benchmark", "list"]);
            expect(listAfter.exitCode).toBe(0);
            expect(listAfter.stdout).not.toContain("e2e-suite");
        });
    });

    describe("remove non-existent", () => {
        it("remove nonexistent shows error", async () => {
            const r = await runTool(["benchmark", "remove", "nonexistent-xyz"]);
            const output = r.stdout + r.stderr;
            expect(output.toLowerCase()).toMatch(/not found|no suite|error|doesn't exist/i);
        });
    });
});
