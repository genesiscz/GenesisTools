import { describe, expect, test } from "bun:test";
import { AGENTS_REGISTRARS } from "@app/agents/registrars";
import { loadUsageSpendAlias } from "@app/ai/commands/usage/spend";
import { AI_REGISTRARS } from "@app/ai/registrars";
import { CLAUDE_REGISTRARS } from "@app/claude/registrars";
import { CMUX_REGISTRARS } from "@app/cmux/registrars";
import { CODEX_REGISTRARS } from "@app/codex/registrars";
import { HUB_REGISTRARS } from "@app/hub/registrars";
import { MACOS_REGISTRARS } from "@app/macos/registrars";
import { MEETINGS_REGISTRARS } from "@app/meetings/registrars";
import { QUESTION_REGISTRARS } from "@app/question/registrars";
import {
    type LazyRegistrar,
    registerRequestedTrees,
    requestedCommandFromArgv,
} from "@genesiscz/utils/cli/lazy-registrars";
import { Command } from "commander";

/**
 * Every tool that hands `runTool` a registrar table, checked by one conformance suite instead of a drift test per
 * tool. runTool matches what the user typed against `names`; a registrar whose command is renamed, or an alias added
 * without a table entry, would silently fall back to loading every tree (the old cost, with nothing to see).
 */
const TABLES: Record<string, readonly LazyRegistrar[]> = {
    agents: AGENTS_REGISTRARS,
    ai: AI_REGISTRARS,
    claude: CLAUDE_REGISTRARS,
    cmux: CMUX_REGISTRARS,
    codex: CODEX_REGISTRARS,
    hub: HUB_REGISTRARS,
    macos: MACOS_REGISTRARS,
    meetings: MEETINGS_REGISTRARS,
    question: QUESTION_REGISTRARS,
};

function registeredNames(program: Command): string[] {
    return program.commands.flatMap((command) => [command.name(), ...command.aliases()]);
}

describe.each(Object.entries(TABLES))("%s registrar table", (tool, registrars) => {
    test("no name is claimed twice", () => {
        const names = registrars.flatMap((entry) => entry.names);

        expect(names.length).toBe(new Set(names).size);
    });

    test("every entry names exactly the commands its registrar adds", async () => {
        for (const entry of registrars) {
            const program = new Command();
            (await entry.load())(program);

            expect(registeredNames(program).sort()).toEqual([...entry.names].sort());
        }
    });

    test("`<name> --help` registers only that name's tree, for every name and alias", async () => {
        for (const entry of registrars) {
            for (const name of entry.names) {
                const program = new Command();
                const requested = requestedCommandFromArgv(["bun", tool, name, "--help"]);
                await registerRequestedTrees({ program, registrars, requested });

                expect(registeredNames(program).sort()).toEqual([...entry.names].sort());
            }
        }
    });

    test("an unknown name and bare --help register every tree, in the table order", async () => {
        for (const argv of [
            ["bun", tool, "not-a-command"],
            ["bun", tool, "--help"],
        ]) {
            const program = new Command();
            await registerRequestedTrees({ program, registrars, requested: requestedCommandFromArgv(argv) });

            expect(registeredNames(program)).toEqual(registrars.flatMap((entry) => entry.names));
        }
    });
});

describe("requestedCommandFromArgv", () => {
    test("skips root flags such as -v", () => {
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

describe("ai usage", () => {
    test("usage carries all three of its registrars", async () => {
        const program = new Command();
        await registerRequestedTrees({ program, registrars: AI_REGISTRARS, requested: "usage" });
        const usage = program.commands.find((command) => command.name() === "usage");

        expect(usage).toBeDefined();
        expect(usage?.commands.map((command) => command.name())).toContain("sessions");
        expect(usage?.commands.map((command) => command.name())).toContain("daemon");
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
});
