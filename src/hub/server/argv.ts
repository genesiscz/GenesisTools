/**
 * The resident server only answers the plain, well-formed shape of each command. Anything else
 * (an unknown flag, a missing value, a value the CLI would refuse) parses to null, the server
 * answers `unsupported`, and the client runs the same argv as a process, which prints the
 * CLI's own error. So a door never has to copy a command's error messages.
 */
export type FlagKind = "bool" | "value";

export interface ArgvShape {
    /** The command words, e.g. ["hub", "agents", "counts"]. */
    command: readonly string[];
    /** How many positional arguments follow the command words (exactly). */
    positionals: number;
    flags: Readonly<Record<string, FlagKind>>;
}

export interface ParsedArgv {
    positionals: string[];
    flags: Map<string, string | true>;
}

export function parseArgv(argv: readonly string[], shape: ArgvShape): ParsedArgv | null {
    if (argv.length < shape.command.length) {
        return null;
    }

    for (const [index, word] of shape.command.entries()) {
        if (argv[index] !== word) {
            return null;
        }
    }

    const positionals: string[] = [];
    const flags = new Map<string, string | true>();
    const rest = argv.slice(shape.command.length);
    for (let index = 0; index < rest.length; index++) {
        const token = rest[index];
        if (!token.startsWith("-")) {
            positionals.push(token);
            continue;
        }

        const kind = shape.flags[token];
        if (!kind || flags.has(token)) {
            return null;
        }

        if (kind === "bool") {
            flags.set(token, true);
            continue;
        }

        const value = rest[index + 1];
        if (value === undefined || value.startsWith("-")) {
            return null;
        }

        flags.set(token, value);
        index++;
    }

    return positionals.length === shape.positionals ? { positionals, flags } : null;
}

/** A non-negative decimal integer, or null (the CLI refuses `1.5`, `3x` and `-1`). */
export function wholeNumber(value: string | true | undefined): number | null {
    if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
        return null;
    }

    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function stringFlag(parsed: ParsedArgv, flag: string): string | undefined {
    const value = parsed.flags.get(flag);
    return typeof value === "string" ? value : undefined;
}
