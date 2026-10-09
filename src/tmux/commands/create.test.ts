import { afterEach, describe, expect, test } from "bun:test";
import { resetTmuxBinCache, setTmuxBinForTests } from "@genesiscz/utils/tmux/bin";
import { setTmuxSpawnSyncForTests } from "@genesiscz/utils/tmux/sessions";
import { Command } from "commander";
import { registerCreateCommand } from "./create";
import { registerSessionsCommand } from "./sessions";

const CREATE_FLAGS = ["--name", "demo", "--cwd", "/tmp/demo", "--command", "/bin/zsh"] as const;

function optionFlags(command: Command | undefined): string[] {
    return (command?.options ?? []).map((option) => option.flags);
}

async function newSessionArgv(argv: string[]): Promise<string[][]> {
    const calls: string[][] = [];
    setTmuxSpawnSyncForTests((cmd) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "" };
    });

    const program = new Command();
    program.exitOverride();
    registerCreateCommand(program);
    registerSessionsCommand(program);
    await program.parseAsync(["node", "tmux", ...argv], { from: "node" });

    return calls.filter((cmd) => cmd.includes("new-session"));
}

describe("tmux sessions create", () => {
    afterEach(() => {
        setTmuxSpawnSyncForTests(null);
        setTmuxBinForTests(null);
        resetTmuxBinCache();
    });

    test("exposes the same options and description as create", () => {
        const program = new Command();
        registerCreateCommand(program);
        registerSessionsCommand(program);

        const create = program.commands.find((command) => command.name() === "create");
        const sessions = program.commands.find((command) => command.name() === "sessions");
        const sessionsCreate = sessions?.commands.find((command) => command.name() === "create");

        expect(optionFlags(sessionsCreate)).toEqual(optionFlags(create));
        expect(sessionsCreate?.description()).toBe(create?.description());
    });

    test("forwards name, cwd, and command the same way as create", async () => {
        setTmuxBinForTests("/mock/tmux");

        const direct = await newSessionArgv(["create", ...CREATE_FLAGS]);
        const nested = await newSessionArgv(["sessions", "create", ...CREATE_FLAGS]);

        expect(nested).toEqual(direct);
        expect(nested[0]).toContain("demo");
        expect(nested[0]).toContain("/tmp/demo");
        expect(nested[0]).toContain("/bin/zsh");
    });
});
