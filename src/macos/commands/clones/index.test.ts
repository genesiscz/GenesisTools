import { describe, expect, it } from "bun:test";
import { registerClonesCommand } from "@app/macos/commands/clones/index";
import { Command } from "commander";

describe("registerClonesCommand", () => {
    it("adds a 'clones' group with the six subcommands", () => {
        const program = new Command();
        registerClonesCommand(program);
        const clones = program.commands.find((c) => c.name() === "clones");
        expect(clones).toBeDefined();
        const subs = clones?.commands.map((c) => c.name()).sort();
        expect(subs).toEqual(["config", "daemon", "du", "duplicates", "measure", "optimize"]);
    });

    it("adds a hidden 'apfs' alias group with the same subcommands", () => {
        const program = new Command();
        registerClonesCommand(program);
        const apfs = program.commands.find((c) => c.name() === "apfs");
        expect(apfs).toBeDefined();
        expect((apfs as unknown as { _hidden?: boolean })._hidden).toBe(true);
        const subs = apfs?.commands.map((c) => c.name()).sort();
        expect(subs).toEqual(["config", "daemon", "du", "duplicates", "measure", "optimize"]);
    });
});
