import { spawnSync } from "node:child_process";

export interface CommandOption {
    flags: string;
    description: string;
}

export interface SubCommand {
    name: string;
    description: string;
}

export interface ToolHelp {
    name: string;
    description: string;
    usage: string;
    commands: SubCommand[];
    options: CommandOption[];
}

/**
 * Run `bun run <scriptPath> --help` and parse the Commander output.
 */
export function introspectTool(scriptPath: string): ToolHelp | null {
    const result = spawnSync("bun", ["run", scriptPath, "--help"], {
        timeout: 5000,
        encoding: "utf-8",
    });

    const output = result.stdout || result.stderr || "";
    if (!output.trim()) {
        return null;
    }

    return parseHelpOutput(output);
}

/**
 * Run --help on a specific subcommand.
 */
export function introspectSubcommand(scriptPath: string, subcommand: string): ToolHelp | null {
    const result = spawnSync("bun", ["run", scriptPath, subcommand, "--help"], {
        timeout: 5000,
        encoding: "utf-8",
    });

    const output = result.stdout || result.stderr || "";
    if (!output.trim()) {
        return null;
    }

    return parseHelpOutput(output);
}

/**
 * Parse Commander-style --help output into structured data.
 *
 * Typical Commander format:
 *   Usage: tool-name [options] [command]
 *
 *   Description text
 *
 *   Options:
 *     -h, --help       display help for command
 *
 *   Commands:
 *     sub [opts]  description
 */
function parseHelpOutput(output: string): ToolHelp {
    const lines = output.split("\n");
    const help: ToolHelp = {
        name: "",
        description: "",
        usage: "",
        commands: [],
        options: [],
    };

    let section: "none" | "options" | "commands" | "description" = "none";

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith("Usage:")) {
            help.usage = trimmed.replace("Usage:", "").trim();
            const parts = help.usage.split(/\s+/);
            if (parts[0]) {
                help.name = parts[0];
            }
            section = "description";
            continue;
        }

        if (/^Options:?\s*$/.test(trimmed)) {
            section = "options";
            continue;
        }
        if (/^Commands:?\s*$/.test(trimmed)) {
            section = "commands";
            continue;
        }

        if (!trimmed && section === "description") {
            continue;
        }

        if (section === "description" && trimmed && !help.description) {
            help.description = trimmed;
            continue;
        }

        if (section === "options" && trimmed) {
            const match = trimmed.match(/^(-\S+(?:,\s*-\S+)*(?:\s+<\S+>)?(?:\s+\[\S+\])?)\s{2,}(.+)/);
            if (match) {
                help.options.push({
                    flags: match[1].trim(),
                    description: match[2].trim(),
                });
            }
            continue;
        }

        if (section === "commands" && trimmed) {
            const match = trimmed.match(/^(\S+(?:\s+\[?\S+\]?)*)\s{2,}(.+)/);
            if (match) {
                help.commands.push({
                    name: match[1].trim(),
                    description: match[2].trim(),
                });
            }
        }
    }

    return help;
}
