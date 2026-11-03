import { describe, expect, test } from "bun:test";
import { registerRequestedTrees, requestedCommandFromArgv } from "@genesiscz/utils/cli/lazy-registrars";
import { Command } from "commander";
import { loadUsageSpendAlias } from "./commands/usage/spend";
import { AI_REGISTRARS } from "./registrars";

/**
 * The argv gate matches what the user typed against `names`. A registrar whose
 * command is renamed, or an alias added without a table entry, would silently
 * fall back to loading every tree — the old cost, with nothing to see.
 */
describe("AI_REGISTRARS", () => {
    test("every entry names exactly the commands its registrar adds", async () => {
        for (const entry of AI_REGISTRARS) {
            const program = new Command();
            (await entry.load())(program);
            const added = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

            expect(added.sort()).toEqual([...entry.names].sort());
        }
    });

    test("no name is claimed twice", () => {
        const names = AI_REGISTRARS.flatMap((entry) => entry.names);

        expect(names.length).toBe(new Set(names).size);
    });

    test("usage carries all three of its registrars", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: AI_REGISTRARS, requested: "usage" });
        const usage = program.commands.find((command) => command.name() === "usage");

        expect(usage).toBeDefined();
        expect(usage?.commands.map((command) => command.name())).toContain("sessions");
        expect(usage?.commands.map((command) => command.name())).toContain("daemon");
    });

    test("an unknown subcommand registers every name in the table", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: AI_REGISTRARS, requested: "not-a-command" });
        const registered = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);

        expect(registered.sort()).toEqual(AI_REGISTRARS.flatMap((entry) => entry.names).sort());
    });

    test("usage spend mounts the tools ai-spend tree only when argv asks for it", async () => {
        const verbs = async (argv: string[]): Promise<string[]> => {
            const usage = new Command("usage");
            (await loadUsageSpendAlias(argv))(usage);
            const spend = usage.commands.find((command) => command.name() === "spend");

            return spend?.commands.map((command) => command.name()) ?? ["(no spend)"];
        };

        expect(await verbs(["bun", "src/ai/index.ts", "usage", "limits"])).toEqual([]);
        expect(await verbs(["bun", "src/ai/index.ts", "usage", "--json", "spend", "daily"])).toEqual(
            expect.arrayContaining(["daily", "weekly", "statusline", "series", "workers", "monitor"])
        );
    });

    test("requestedCommandFromArgv skips root flags such as -v", () => {
        expect(requestedCommandFromArgv(["bun", "src/ai/index.ts", "-v", "accounts"])).toBe("accounts");
        expect(requestedCommandFromArgv(["bun", "src/ai/index.ts", "--verbose", "who"])).toBe("who");
        expect(requestedCommandFromArgv(["bun", "src/ai/index.ts", "translate", "--to", "en"])).toBe("translate");
        expect(requestedCommandFromArgv(["bun", "src/ai/index.ts", "--help"])).toBeUndefined();
    });

    test("an inline command already on the program registers no extra trees", async () => {
        const program = new Command();
        program.command("translate");
        await registerRequestedTrees({ program, registrars: AI_REGISTRARS, requested: "translate" });

        expect(program.commands.map((command) => command.name())).toEqual(["translate"]);
    });
});
