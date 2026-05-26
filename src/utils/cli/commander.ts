import { basename, dirname } from "node:path";
import { setBaseBinding, setConsoleLevel } from "@app/logger";
import { consoleFloorFor } from "@app/utils/logging/tool-policy";
import { printReadmeAndExit } from "@app/utils/readme";
import type { Command } from "commander";
import { enhanceHelp } from "./executor";
// `logger` itself is intentionally NOT imported here — runTool only drives the
// console gate / base binding via the setters above (importing the logger
// value into commander.ts would risk a commander↔logger value cycle).

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

export function addGlobalVerboseOption<T extends Command>(program: T, opts: { trace?: boolean } = {}): T {
    if (!optionExists(program, "-v") && !optionExists(program, "--verbose")) {
        // Description text is intentionally the historical canonical
        // "Enable verbose logging" (matching every pre-overhaul bespoke -v) so
        // that after codemod-4b re-adds this global option, the golden --help
        // anchors (gitcommit_help, npmdiff_help) render byte-identical to HEAD.
        program.option("-v, --verbose", "Enable verbose logging", incrementVerbosity, 0);
    }

    // `--trace` is opt-in (trace-gated): only registered when explicitly
    // requested, so most tools never expose a trace flag at all.
    if (opts.trace === true && !optionExists(program, "--trace")) {
        program.option("--trace", "Enable trace logging");
    }

    program.hook("preAction", (thisCommand) => {
        applyVerbosityToEnv(Math.max(getArgvVerbosity(), getCommandVerbosity(thisCommand)));
    });

    return program;
}

export interface RunToolOpts {
    tool?: string;
    trace?: boolean;
    enhanceHelp?: boolean;
    ignoreParams?: string[];
}

export interface RunToolResult {
    tool: string;
    verbosity: Verbosity;
    isVerbose: boolean;
    command: Command;
}

let _verbosity: Verbosity = 0;

export function getVerbosity(): Verbosity {
    return _verbosity;
}

export function isVerbose(): boolean {
    return _verbosity >= 1;
}

function callerDirOf(argv: readonly string[]): string {
    return dirname(argv[1] ?? "");
}

export function argvRequestsReadme(args: string[]): boolean {
    // Stop at the conventional `--` separator: everything after it is meant
    // for a wrapped child command (e.g. `tools task run -- bash --readme`),
    // not for the wrapper itself. Scanning past it caused the wrapper to
    // hijack any child whose own flags happened to include --readme.
    for (const arg of args) {
        if (arg === "--") {
            return false;
        }

        if (arg === "--readme" || arg.startsWith("--readme=")) {
            return true;
        }
    }

    return false;
}

/**
 * Unified tool bootstrap: registers the non-destructive `-v`/`--verbose`
 * (and trace-gated `--trace`) option + a visible `--readme` flag, resolves
 * the console level from argv verbosity (or the per-tool floor), applies the
 * `{ tool }` base binding, then parses. argv is never mutated/spliced.
 */
export async function runTool(
    program: Command,
    opts: RunToolOpts = {},
    argv: string[] = process.argv
): Promise<RunToolResult> {
    const tool = opts.tool ?? program.name() ?? basename(argv[1] ?? "tool");

    if (!opts.ignoreParams?.includes("verbose")) {
        addGlobalVerboseOption(program, { trace: opts.trace === true });
    }

    if (opts.enhanceHelp) {
        enhanceHelp(program);
    }

    if (!program.options.some((o) => o.long === "--readme")) {
        program.option("--readme", "Print this tool's README and exit");
    }

    const readmeInArgv = argvRequestsReadme(argv.slice(2));
    if (readmeInArgv) {
        printReadmeAndExit(callerDirOf(argv));
    }

    program.hook("preAction", () => {
        if (program.opts().readme) {
            printReadmeAndExit(callerDirOf(argv));
        }
    });

    _verbosity = getArgvVerbosity(argv.slice(2));
    const level = _verbosity >= 2 && opts.trace === true ? "trace" : _verbosity >= 1 ? "debug" : consoleFloorFor(tool);
    setConsoleLevel(level);
    setBaseBinding({ tool });

    await program.parseAsync(argv);
    return { tool, verbosity: _verbosity, isVerbose: _verbosity >= 1, command: program };
}
