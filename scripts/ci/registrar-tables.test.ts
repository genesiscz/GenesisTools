import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_REGISTRARS } from "@app/agents/registrars";
import { loadUsageSpendAlias } from "@app/ai/commands/usage/spend";
import { AI_REGISTRARS } from "@app/ai/registrars";
import AI_PROXY_CLI_CONTRACTS from "@app/ai-proxy/commands/registrars/__fixtures__/cli-contracts.json";
import { AI_PROXY_REGISTRARS } from "@app/ai-proxy/registrars";
import { CLAUDE_REGISTRARS } from "@app/claude/registrars";
import { CMUX_REGISTRARS } from "@app/cmux/registrars";
import { CODEX_REGISTRARS } from "@app/codex/registrars";
import { HUB_REGISTRARS } from "@app/hub/registrars";
import { MACOS_REGISTRARS } from "@app/macos/registrars";
import { MEETINGS_REGISTRARS } from "@app/meetings/registrars";
import { QUESTION_REGISTRARS } from "@app/question/registrars";
import RECORDER_CLI_CONTRACTS from "@app/recorder/commands/registrars/__fixtures__/cli-contracts.json";
import { createRecorderProgram, RECORDER_REGISTRARS } from "@app/recorder/registrars";
import { runTool } from "@genesiscz/utils/cli";
import {
    type LazyRegistrar,
    registerRequestedTrees,
    requestedCommandFromArgv,
} from "@genesiscz/utils/cli/lazy-registrars";
import { env } from "@genesiscz/utils/env";
import { Command, CommanderError } from "commander";

/**
 * Every tool that hands `runTool` a registrar table, checked by one conformance suite instead of a drift test per
 * tool. runTool matches what the user typed against `names`; a registrar whose command is renamed, or an alias added
 * without a table entry, would silently fall back to loading every tree (the old cost, with nothing to see).
 */
const TABLES: Record<string, readonly LazyRegistrar[]> = {
    agents: AGENTS_REGISTRARS,
    ai: AI_REGISTRARS,
    "ai-proxy": AI_PROXY_REGISTRARS,
    claude: CLAUDE_REGISTRARS,
    cmux: CMUX_REGISTRARS,
    codex: CODEX_REGISTRARS,
    hub: HUB_REGISTRARS,
    macos: MACOS_REGISTRARS,
    meetings: MEETINGS_REGISTRARS,
    question: QUESTION_REGISTRARS,
    recorder: RECORDER_REGISTRARS,
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

    test("root help and unknown root options register every tree, even before a known command", async () => {
        const firstName = registrars[0]?.names[0];
        if (!firstName) {
            throw new Error("A registrar table must declare a command");
        }

        for (const argv of [
            ["bun", tool, "not-a-command"],
            ["bun", tool, "--help"],
            ["bun", tool, "--help", firstName],
            ["bun", tool, "-h", firstName],
            ["bun", tool, "--unknown=value", firstName],
            ["bun", tool, "--unknown", "value", firstName],
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

interface CliContract {
    argv: string[];
    exit: number;
    stdout: string;
    stderr: string;
}

/**
 * Runs one argv through runTool's argv gate in this process, as the tool's index.ts does, and returns what commander
 * printed. The fixtures were captured from the tool's eager tree (every command inline) before its extraction.
 */
async function runContract({
    program,
    tool,
    registrars,
    argv,
}: {
    program: Command;
    tool: string;
    registrars: readonly LazyRegistrar[];
    argv: string[];
}): Promise<CliContract> {
    let stdout = "";
    let stderr = "";
    let exit = 0;
    program.exitOverride().configureOutput({
        writeOut: (text) => {
            stdout += text;
        },
        writeErr: (text) => {
            stderr += text;
        },
        getOutHelpWidth: () => 80,
        getErrHelpWidth: () => 80,
    });
    program.hook("preAction", () => {
        throw new Error("A CLI contract probe must never execute a command action");
    });

    try {
        await runTool(program, { tool, registrars }, [process.execPath, `src/${tool}/index.ts`, ...argv]);
    } catch (error) {
        if (!(error instanceof CommanderError)) {
            throw error;
        }

        exit = error.exitCode;
    }

    return { argv, exit, stdout, stderr };
}

describe("ai-proxy CLI extraction contract", () => {
    test("help and usage errors match the eager tree byte for byte through runTool's argv gate", async () => {
        for (const fixture of AI_PROXY_CLI_CONTRACTS.filter((entry) => !entry.argv.includes("--readme"))) {
            const program = new Command()
                .name("ai-proxy")
                .description("OpenAI-compatible local proxy for Grok, GitHub Copilot, and other AI providers")
                .version("0.1.0");
            const result = await runContract({
                program,
                tool: "ai-proxy",
                registrars: AI_PROXY_REGISTRARS,
                argv: fixture.argv,
            });

            expect(result).toEqual(fixture);
        }
    });

    test("root and subcommand --readme print the same tool README and exit before any action", async () => {
        const childHome = mkdtempSync(join(tmpdir(), "gt-ai-proxy-readme-"));
        const outputs: string[] = [];
        for (const argv of [["--readme"], ["models", "--readme"]]) {
            const child = Bun.spawn([process.execPath, "src/ai-proxy/index.ts", ...argv], {
                cwd: new URL("../../", import.meta.url).pathname,
                env: {
                    ...env.testing.snapshot(),
                    GENESIS_TOOLS_HOME: childHome,
                    NO_COLOR: "1",
                    FORCE_COLOR: undefined,
                    PROFILE_TO_STDERR: "0",
                },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stdout, stderr, exit] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            expect(exit).toBe(0);
            expect(stderr).toBe("");
            expect(stdout).toStartWith("# tools ai-proxy\n");
            outputs.push(stdout);
        }

        expect(outputs[0]).toBe(outputs[1]);
    });
});

describe("recorder CLI extraction contract", () => {
    test("help and usage errors match the eager tree byte for byte through runTool's argv gate", async () => {
        for (const fixture of RECORDER_CLI_CONTRACTS) {
            const result = await runContract({
                program: createRecorderProgram(),
                tool: "recorder",
                registrars: RECORDER_REGISTRARS,
                argv: fixture.argv,
            });

            expect(result).toEqual(fixture);
        }
    });
});
