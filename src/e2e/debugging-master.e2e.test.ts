import { describe, expect, it } from "bun:test";
import { runTool } from "./helpers";

describe("tools debugging-master", () => {
    describe("help", () => {
        it("--help exits 0 and shows description", async () => {
            const r = await runTool(["debugging-master", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("debugging toolkit");
        });
    });

    describe("sessions", () => {
        it("sessions --help exits 0", async () => {
            const r = await runTool(["debugging-master", "sessions", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("sessions");
        });
    });

    describe("tail", () => {
        it("tail --help exits 0 and mentions --level", async () => {
            const r = await runTool(["debugging-master", "tail", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("Live-tail");
            expect(r.stdout).toContain("--level");
        });
    });

    describe("delete-session", () => {
        it("delete-session --help exits 0 and shows --inactive, --all, --force", async () => {
            const r = await runTool(["debugging-master", "delete-session", "--help"]);
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain("--inactive");
            expect(r.stdout).toContain("--all");
            expect(r.stdout).toContain("--force");
        });

        it("delete-session with no args and no sessions exits with error", async () => {
            const r = await runTool(["debugging-master", "delete-session"]);
            expect(r.exitCode).not.toBe(0);
            const output = r.stdout + r.stderr;
            expect(output).toContain("No session names provided");
        });

        it("delete-session --inactive --force works even with no sessions", async () => {
            const r = await runTool(["debugging-master", "delete-session", "--inactive", "--force"]);
            expect(r.exitCode).toBe(0);
            const output = r.stdout + r.stderr;
            expect(output).toContain("No inactive sessions");
        });
    });
});
