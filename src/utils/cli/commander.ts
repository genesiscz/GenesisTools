import type { Command } from "commander";

export type Verbosity = 0 | 1 | 2 | 3;

interface VerboseOptions {
    verbose?: boolean | number;
    trace?: boolean;
}

function clampVerbosity(value: number): Verbosity {
    if (value <= 0) {
        return 0;
    }

    if (value === 1) {
        return 1;
    }

    if (value === 2) {
        return 2;
    }

    return 3;
}

function incrementVerbosity(_value: string, previous: number): number {
    return previous + 1;
}

function optionExists(command: Command, flag: string): boolean {
    return command.options.some((option) => option.short === flag || option.long === flag);
}

export function getArgvVerbosity(argv: readonly string[] = process.argv.slice(2)): Verbosity {
    let count = 0;
    let sawDoubleDash = false;

    for (const arg of argv) {
        if (sawDoubleDash) {
            continue;
        }

        if (arg === "--") {
            sawDoubleDash = true;
            continue;
        }

        if (arg === "--trace") {
            count = Math.max(count, 2);
            continue;
        }

        if (arg === "--verbose" || arg.startsWith("--verbose=")) {
            count += 1;
            continue;
        }

        if (/^-v+$/.test(arg)) {
            count += arg.length - 1;
        }
    }

    return clampVerbosity(count);
}

export function applyVerbosityToEnv(verbosity: number): void {
    if (verbosity >= 1) {
        process.env.LOG_DEBUG = "1";
    }

    if (verbosity >= 2) {
        process.env.LOG_TRACE = "1";
    }
}

function getCommandVerbosity(command: Command): Verbosity {
    const opts = command.optsWithGlobals<VerboseOptions>();
    let count = 0;

    if (typeof opts.verbose === "number") {
        count = Math.max(count, opts.verbose);
    }

    if (opts.verbose === true) {
        count = Math.max(count, 1);
    }

    if (opts.trace === true) {
        count = Math.max(count, 2);
    }

    return clampVerbosity(count);
}

export function addGlobalVerboseOption<T extends Command>(program: T): T {
    if (!optionExists(program, "-v") && !optionExists(program, "--verbose")) {
        program.option("-v, --verbose", "Enable verbose logging; repeat for trace logging", incrementVerbosity, 0);
    }

    if (!optionExists(program, "--trace")) {
        program.option("--trace", "Enable trace logging");
    }

    program.hook("preAction", (thisCommand) => {
        applyVerbosityToEnv(Math.max(getArgvVerbosity(), getCommandVerbosity(thisCommand)));
    });

    return program;
}
