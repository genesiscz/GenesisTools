import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Command } from "commander";

async function _makeProgram(): Promise<Command> {
    const { registerServerCommand } = await import("@app/youtube/commands/server");
    const program = new Command().exitOverride();
    registerServerCommand(program);

    return program;
}

describe("youtube server command", () => {
    let stdout = "";
    let stdoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        stdout = "";
        stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdout += String(chunk);
            return true;
        });
    });

    afterEach(() => {
        stdoutSpy.mockRestore();
    });

    it("lists server lifecycle subcommands in help", async () => {
        const program = new Command().exitOverride((error) => {
            throw error;
        });
        const { registerServerCommand } = await import("@app/youtube/commands/server");
        registerServerCommand(program);

        expect(() => program.parse(["node", "test", "server", "--help"])).toThrow("(outputHelp)");

        expect(stdout).toContain("start");
        expect(stdout).toContain("stop");
        expect(stdout).toContain("status");
        expect(stdout).toContain("install");
    });
});
