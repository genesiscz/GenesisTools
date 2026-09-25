import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { focusedPlace, launchTarget, openCommandAt } from "@genesiscz/utils/cmux/open-command";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { buildCmuxCommand, type ClaudeLaunch } from "../lib/launchers/claudeLauncher";

interface LaunchFlags {
    agent?: string | true;
    account?: string;
    prompt?: string;
    promptFile?: string;
    name?: string;
    resume?: string;
    model?: string;
    cwd?: string;
    surface?: string | true;
    runArg?: string[];
    claudeArg?: string[];
    json?: boolean;
    open?: boolean;
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

function blank(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

export function registerLaunchCommand(program: Command): void {
    program
        .command("launch")
        .description("Print the quoted command that opens Claude in a new cmux surface, or run it there with --open")
        .argument("[claudeArgs...]", "Extra claude arguments, after --. Same destination as --claude-arg.")
        .option("--account <name>", "Saved Claude account. Empty or omitted: the default Claude account.")
        .option("--prompt <text>")
        .option("--prompt-file <path>", "Read the prompt from a file. Not subject to the 8 KB URL cap.")
        .option("--name <name>")
        .option("--resume <query>")
        .option("--model <model>")
        .option("--cwd <dir>")
        .option("--surface [kind]", "new (default), split, or workspace; with --open, where the command runs")
        .option("--agent [name]", "Which launcher to use: claude (the only one so far)")
        .option(
            "--run-arg <arg>",
            "Extra argument for `tools claude run`, before --. Repeatable.",
            collect,
            [] as string[]
        )
        .option("--claude-arg <arg>", "Extra argument for claude, after --. Repeatable.", collect, [] as string[])
        .option("--json", "Print the launch plan as JSON instead of the shell line")
        .option(
            "--open",
            "Open the surface in cmux and type the command there (a new tab in the focused pane, a split, or a new workspace)"
        )
        .action(async (claudeArgs: string[], options: LaunchFlags) => {
            try {
                // Only claude has a launcher so far (src/cmux/lib/launchers/claudeLauncher.ts).
                assertLauncherExists(options.agent);
                const agent = await pickEnum({
                    flag: "--agent",
                    raw: options.agent,
                    values: AGENTS,
                    fallback: "claude",
                });
                const surface = await pickEnum({
                    flag: "--surface",
                    raw: options.surface,
                    values: SURFACES,
                    fallback: "new",
                });

                if (!agent || !surface) {
                    return;
                }

                const fromFile = options.promptFile ? readFileSync(options.promptFile, "utf8") : undefined;
                const prompt = fromFile ?? options.prompt;

                if (!prompt) {
                    throw new Error("pass --prompt or --prompt-file");
                }

                const launch: ClaudeLaunch = {
                    account: blank(options.account) ?? (await defaultClaudeAccount()),
                    prompt,
                    name: blank(options.name),
                    resume: blank(options.resume),
                    model: blank(options.model),
                    cwd: blank(options.cwd),
                    surface,
                    runArgs: options.runArg,
                    claudeArgs: [...(options.claudeArg ?? []), ...claudeArgs],
                    enforceCap: fromFile === undefined,
                    // Absolute: the command may `cd` into --cwd before it reads the file.
                    ...(options.promptFile ? { promptFile: resolve(options.promptFile) } : {}),
                };

                if (options.open) {
                    const command = buildCmuxCommand(launch);
                    const placed = await openCommandAt({
                        command,
                        target: launchTarget(launch.surface, await focusedPlace()),
                        title: launch.name ?? "claude",
                        workspaceName: launch.name,
                        cwd: launch.cwd,
                    });
                    logger.info({ ...placed, surface: launch.surface ?? "new" }, "cmux launch opened");
                    out.println(`Opened in cmux ${placed.workspaceRef} ${placed.surfaceRef}`);
                    return;
                }

                if (options.json) {
                    out.result({
                        agent,
                        surface,
                        account: launch.account,
                        cwd: launch.cwd ?? null,
                        resume: launch.resume ?? null,
                        name: launch.name ?? null,
                        model: launch.model ?? null,
                        prompt: launch.prompt,
                        runArgs: launch.runArgs ?? [],
                        claudeArgs: launch.claudeArgs ?? [],
                        command: buildCmuxCommand(launch),
                    });
                    return;
                }

                out.println(buildCmuxCommand(launch));
            } catch (error) {
                out.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
const SURFACES = ["new", "split", "workspace"] as const;
const AGENTS = ["claude"] as const;

/** A named agent without a launcher module fails and names the file that would add it. */
export function assertLauncherExists(agent: string | true | undefined): void {
    const name = typeof agent === "string" ? agent.trim() : "";

    if (name === "" || AGENTS.some((known) => known === name) || !/^[a-z][a-z0-9-]*$/.test(name)) {
        return;
    }

    throw new Error(`no launcher for ${name}: add src/cmux/lib/launchers/${name}Launcher.ts`);
}

/**
 * The account a link that names none launches under: the default Claude account, the same one
 * `tools claude` picks. A minted handoff link carries no account, so the click resolves it here.
 */
async function defaultClaudeAccount(): Promise<string> {
    const config = await AIConfig.load();
    const account = config.getDefaultAccount("claude");

    if (!account) {
        throw new Error("no default Claude account; pass --account <name>");
    }

    logger.debug({ account: account.name }, "cmux launch: using the default Claude account");
    return account.name;
}

/**
 * A closed-set flag. Omitted or empty is the default: a link whose `{surface}` placeholder was not
 * filled passes `--surface ""`. A bare flag or an unknown value opens a picker on a TTY; otherwise it
 * prints the values with a filled command and fails. Null means stop (cancelled or reported).
 */
async function pickEnum<T extends string>({
    flag,
    raw,
    values,
    fallback,
}: {
    flag: string;
    raw: string | true | undefined;
    values: readonly T[];
    fallback: T;
}): Promise<T | null> {
    const given = typeof raw === "string" ? raw.trim() : raw;

    if (given === undefined || given === "") {
        return fallback;
    }

    const known = values.find((value) => value === given);

    if (known) {
        return known;
    }

    if (isInteractive()) {
        const picked = await p.select<string>({
            message: `Pick ${flag}`,
            options: values.map((value): { value: string; label: string } => ({ value, label: value })),
        });
        return p.isCancel(picked) ? null : (values.find((value) => value === picked) ?? null);
    }

    out.error(
        suggestEnumFlag("tools cmux launch", flag, values, {
            subcommand: ["launch"],
            given: typeof given === "string" ? given : undefined,
        })
    );
    process.exitCode = 1;
    return null;
}
