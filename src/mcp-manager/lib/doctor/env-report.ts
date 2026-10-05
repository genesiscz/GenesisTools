import { delimiter } from "node:path";

export interface CommandResult {
    success: boolean;
    exitCode: number;
    command: string;
    stdout: string;
    stderr: string;
    error?: string;
}

export interface EnvReport {
    success: boolean;
    exitCode: number;
    cwd: string;
    /** `PATH` split into its entries, in lookup order. */
    path: string[];
    env: Record<string, string | undefined>;
    commands: CommandResult[];
}

export interface CommandOutcome {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
}

export type RunCommand = (parts: string[]) => Promise<CommandOutcome>;

/** The positional command first, then each non-empty `;`-separated entry of the `COMMANDS` variable. */
export function collectCommands(args: string[], commandsEnv: string | undefined): string[] {
    const commands: string[] = [];

    if (args.length > 0) {
        commands.push(args.join(" "));
    }

    for (const entry of (commandsEnv ?? "").split(";")) {
        const command = entry.trim();
        if (command.length > 0) {
            commands.push(command);
        }
    }

    return commands;
}

/** Split on whitespace. Quotes are not interpreted: quote at the shell, or run a script. */
export function splitCommand(commandString: string): string[] {
    return commandString.trim().split(/\s+/).filter(Boolean);
}

export async function runCommandString(commandString: string, run: RunCommand): Promise<CommandResult> {
    const command = commandString.trim();
    const parts = splitCommand(command);

    if (parts.length === 0) {
        return { success: false, exitCode: 1, command, stdout: "", stderr: "", error: "empty command" };
    }

    try {
        const { success, exitCode, stdout, stderr } = await run(parts);

        return { success, exitCode, command, stdout, stderr };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return { success: false, exitCode: 1, command, stdout: "", stderr: "", error: message };
    }
}

export function splitPath(env: Record<string, string | undefined>): string[] {
    return (env.PATH ?? env.Path ?? "").split(delimiter).filter((entry) => entry.length > 0);
}

/**
 * The environment, PATH and cwd a process was started with, plus the output of the commands run in it.
 * The overall exit code is the one of the last command that failed.
 */
export function buildEnvReport(input: {
    cwd: string;
    env: Record<string, string | undefined>;
    results: CommandResult[];
}): EnvReport {
    let exitCode = 0;

    for (const result of input.results) {
        if (!result.success) {
            exitCode = result.exitCode || 1;
        }
    }

    return {
        success: exitCode === 0,
        exitCode,
        cwd: input.cwd,
        path: splitPath(input.env),
        env: input.env,
        commands: input.results,
    };
}
