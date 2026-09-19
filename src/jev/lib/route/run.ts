import { execTool, execToolInteractive, isInteractive } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { RouteDecision } from "./router";

const { log } = logger.scoped("jev-route");
const prof = profiler.scope("jev-route");

export interface RouteExecResult {
    exitCode: number;
    stdout?: string;
    stderr?: string;
}

export type RouteExecutor = (args: string[]) => Promise<RouteExecResult>;

export interface RouteRunOutcome {
    executed: boolean;
    exitCode?: number;
    /** Why the run did not happen. */
    refused?:
        | "not_admitted"
        | "destructive_needs_yes"
        | "destructive_declined"
        | "empty_argv"
        | "missing_required_argument";
    argv: string[];
    /** Captured output, present only when the executor piped it. */
    stdout?: string;
    stderr?: string;
}

/**
 * Strip the printed `tools` head; `execTool` already knows where the tools entry point is.
 */
export function toolArgs(argv: string[]): string[] {
    return argv[0] === "tools" ? argv.slice(1) : [...argv];
}

/**
 * The real executor. A TTY gets inherited stdio so an interactive tool still works; a pipe gets
 * the captured variant and its output is forwarded by the caller.
 */
export const defaultRouteExecutor: RouteExecutor = async (args) => {
    if (isInteractive()) {
        log.info({ args, mode: "interactive" }, "Spawning the routed command with inherited stdio");
        const result = await execToolInteractive(args);
        return { exitCode: result.exitCode };
    }

    log.info({ args, mode: "captured" }, "Spawning the routed command with captured stdio");
    const result = await execTool(args);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

/**
 * Run an admitted route.
 *
 * Refuses unless the decision was admitted, and refuses a destructive command without `--yes`
 * in a non-interactive shell or without a confirm in an interactive one. The confirm callback
 * is injected so the gate is testable without a terminal.
 */
export async function runRoutedDecision(options: {
    decision: RouteDecision;
    yes?: boolean;
    execute?: RouteExecutor;
    confirm?: () => Promise<boolean>;
}): Promise<RouteRunOutcome> {
    const { decision } = options;
    const argv = decision.argv;
    if (decision.status !== "admitted") {
        log.warn(
            { status: decision.status, reason: decision.reason },
            "Refusing --run for a route that was not admitted"
        );
        return { executed: false, refused: "not_admitted", argv };
    }

    if (!argv.length) {
        return { executed: false, refused: "empty_argv", argv };
    }

    // A command whose required positional stayed unbound would only print its own help and exit
    // non-zero. Refusing here keeps `--run` from looking like it did something.
    const missing = decision.unbound.filter((entry) => entry.endsWith("unbound-required"));
    if (missing.length) {
        log.warn({ argv, missing }, "Refusing --run because a required argument was never bound");
        return { executed: false, refused: "missing_required_argument", argv };
    }

    if (decision.destructive && !options.yes) {
        if (!options.confirm) {
            log.warn({ argv }, "Refusing a destructive --run without --yes");
            return { executed: false, refused: "destructive_needs_yes", argv };
        }

        const approved = await options.confirm();
        if (!approved) {
            log.warn({ argv }, "Destructive --run declined at the confirm prompt");
            return { executed: false, refused: "destructive_declined", argv };
        }
    }

    const execute = options.execute ?? defaultRouteExecutor;
    const args = toolArgs(argv);
    log.info({ argv, destructive: decision.destructive }, "Running the routed command");
    const result = await prof.measureAsync("run", () => execute(args));
    log.info({ argv, exitCode: result.exitCode }, "Routed command finished");
    return {
        executed: true,
        exitCode: result.exitCode,
        argv,
        ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
        ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    };
}
