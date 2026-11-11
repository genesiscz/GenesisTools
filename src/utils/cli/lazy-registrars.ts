import type { Command } from "commander";

/**
 * One subcommand tree, imported only when that tree is the one being run.
 *
 * A CLI that registers every tree at module load pays for all of them on every
 * invocation, and registration is not free: a tree whose registrar builds a
 * dashboard app or reads a config does that work before commander has even
 * looked at argv. `tools macos` measured 47% of its wall time there.
 *
 * `names` is the command name plus every alias, because argv carries what the
 * user typed, not what commander calls the command.
 */
export interface LazyRegistrar {
    names: string[];
    load: () => Promise<(program: Command) => void>;
}

/**
 * Registers the one tree argv asks for, or every tree when argv asks for
 * something else.
 *
 * Help, no arguments and an unknown subcommand all take the full path, because
 * all three render every description. A name that drifts out of the table only
 * costs the full path again, so drift degrades to the old behaviour rather than
 * to a missing command.
 */
const BOOLEAN_ROOT_FLAGS = new Set(["-v", "-vv", "-h", "--verbose", "--trace", "--readme", "--help", "--version"]);

/**
 * The first subcommand after known boolean root flags such as `-v`.
 * Root help and unrecognized root options load every tree, so Commander's root help and
 * usage errors retain the complete command list even when a known name follows the flag.
 */
export function requestedCommandFromArgv(argv: readonly string[]): string | undefined {
    const args = argv.slice(2);

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--") {
            return args[i + 1];
        }

        if (!arg.startsWith("-")) {
            return arg;
        }

        if (arg === "-h" || arg === "--help") {
            return undefined;
        }

        if (BOOLEAN_ROOT_FLAGS.has(arg)) {
            continue;
        }

        return undefined;
    }
}

export async function registerRequestedTrees({
    program,
    registrars,
    requested,
}: {
    program: Command;
    registrars: readonly LazyRegistrar[];
    requested: string | undefined;
}): Promise<void> {
    const alreadyRegistered =
        requested !== undefined &&
        program.commands.some((command) => command.name() === requested || command.aliases().includes(requested));

    if (alreadyRegistered) {
        return;
    }

    const matched = requested ? registrars.find((entry) => entry.names.includes(requested)) : undefined;

    for (const entry of matched ? [matched] : registrars) {
        (await entry.load())(program);
    }
}
