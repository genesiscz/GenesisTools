import { describe, expect, it } from "bun:test";
import { execTool } from "@app/utils/e2e/helpers";
import { skip } from "@app/utils/test/skip";

describe("tools notify", () => {
    describe("help & no-args", () => {
        it("--help exits 0 and shows description", async () => {
            const r = await execTool(["notify", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Send macOS notifications");
        });

        it("--help shows all options", async () => {
            const r = await execTool(["notify", "--help"]);
            for (const flag of ["--title", "--subtitle", "--sound", "--group"]) {
                expect(r.stdout).toContain(flag);
            }
        });

        it("no args exits 0 and shows help", async () => {
            const r = await execTool(["notify"]);
            expect(r.exitCode).toBe(0);
        });
    });

    // These spawn the real `tools notify`, which fires an actual macOS
    // notification and can block (no GUI / notification daemon in CI &
    // headless). Opt-in via RUN_NOTIFY_E2E=1.
    describe.skipIf(skip.notifyE2E)("sending notifications", () => {
        it("sends basic notification", async () => {
            const r = await execTool(["notify", "e2e test", "--title", "E2E"]);
            expect(r.exitCode).toBe(0);
        });

        it("sends with subtitle and sound", async () => {
            const r = await execTool(["notify", "e2e test", "--title", "E2E", "--subtitle", "sub", "--sound", "Ping"]);
            expect(r.exitCode).toBe(0);
        });

        it("sends with group ID", async () => {
            const r = await execTool(["notify", "e2e test", "--group", "e2e-group"]);
            expect(r.exitCode).toBe(0);
        });
    });

    describe("config subcommand", () => {
        it("config --help exits 0", async () => {
            const r = await execTool(["notify", "config", "--help"]);
            expect(r.exitCode).toBe(0);
        });
    });
});
