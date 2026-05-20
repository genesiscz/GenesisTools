import { describe, expect, it, mock } from "bun:test";

const registerSpy = mock(async () => true);
const unregisterSpy = mock(async () => true);
mock.module("@app/daemon/lib/register", () => ({
    registerTask: registerSpy,
    unregisterTask: unregisterSpy,
}));

const { createDaemonCommand } = await import("@app/macos/commands/clones/daemon");

describe("createDaemonCommand", () => {
    it("has enable/disable/status subcommands", () => {
        const subs = createDaemonCommand()
            .commands.map((c) => c.name())
            .sort();
        expect(subs).toEqual(["disable", "enable", "status"]);
    });

    it("enable registers an ABSOLUTE-path command for macos-clones-scan (shell-quoted)", async () => {
        await createDaemonCommand().parseAsync(["node", "daemon", "enable"], { from: "node" });
        expect(registerSpy).toHaveBeenCalled();
        const calls = registerSpy.mock.calls as unknown as Array<[{ name: string; command: string; every: string }]>;
        const arg = calls[0][0];
        expect(arg.name).toBe("macos-clones-scan");
        // Paths are POSIX-shell-quoted: `'/abs/path' run '/abs/path'`. Both
        // paths must be absolute and quoted so spaces/quotes in dev paths
        // (~/Library/...) don't inject into the shell `tools daemon` runs.
        expect(arg.command).toMatch(/^'\/.+' run '\/.+\/scan-daemon\.ts'$/);
        expect(arg.command).toContain("scan-daemon.ts");
        expect(arg.every).toBe("every day at 03:00");
    });
});
