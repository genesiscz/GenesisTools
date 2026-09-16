import { describe, expect, test } from "bun:test";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { Command } from "commander";
import { CLAUDE_REGISTRARS } from "./registrars";

/**
 * The argv gate matches what the user typed against `names`. A registrar whose
 * command is renamed, or an alias added without a table entry, would silently
 * fall back to loading all 28 trees — the old cost, with nothing to see. These
 * assert the table against what the registrars really register.
 */
describe("CLAUDE_REGISTRARS", () => {
    test("every entry names exactly the commands its registrar adds", async () => {
        for (const entry of CLAUDE_REGISTRARS) {
            const program = new Command();
            (await entry.load())(program);
            const added = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

            expect(added.sort()).toEqual([...entry.names].sort());
        }
    });

    test("no name is claimed twice", () => {
        const names = CLAUDE_REGISTRARS.flatMap((entry) => entry.names);

        expect(names.length).toBe(new Set(names).size);
    });

    test("an unknown subcommand registers every name in the table", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: CLAUDE_REGISTRARS, requested: "not-a-command" });
        const registered = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

        expect(registered.sort()).toEqual(CLAUDE_REGISTRARS.flatMap((entry) => entry.names).sort());
    });

    test("a known subcommand registers only its own tree", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: CLAUDE_REGISTRARS, requested: "who" });

        expect(program.commands.map((command) => command.name())).toEqual(["who"]);
    });

    test("an alias takes the same fast path as the command name", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: CLAUDE_REGISTRARS, requested: "active" });

        expect(program.commands.map((command) => command.name())).toEqual(["who"]);
    });
});
