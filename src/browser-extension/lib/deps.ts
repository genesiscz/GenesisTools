import { join } from "node:path";
import { collectOutput, execTool } from "@genesiscz/utils/cli";
import { checkoutsAt, discoverCheckouts, type LocalCheckout } from "@genesiscz/utils/git/local-checkouts";
import { logger } from "@genesiscz/utils/logger";
import {
    type EditorDriver,
    type EditorDriverId,
    editorDriver,
    type RunResult,
    type TerminalDriver,
    type TerminalDriverId,
    terminalDriver,
} from "@genesiscz/utils/open-in";
import { type BrowserExtensionConfig, browserExtensionStorage, loadConfig } from "./config";

export interface RunOptions {
    cwd?: string;
    timeoutMs: number;
    /** Written to the child's stdin, then closed. */
    stdin?: string;
}

/** Runs one argv, never a shell. A timeout kills the child and comes back as exit 124. */
export type Runner = (argv: string[], opts: RunOptions) => Promise<RunResult>;

/** Everything the features touch outside their own logic; tests pass fakes. */
export interface Deps {
    config(): Promise<BrowserExtensionConfig>;
    checkouts(config: BrowserExtensionConfig): LocalCheckout[];
    run: Runner;
    /** `tools <args>` through the worktree-safe `execTool`. */
    tools(args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunResult>;
    editor(id: EditorDriverId): EditorDriver;
    terminal(id: TerminalDriverId): TerminalDriver;
    /** Where prompt files are written. */
    promptDir: string;
    now(): Date;
}

const log = logger.child({ component: "browser-extension/run" });

export const spawnArgv: Runner = async (argv, { cwd, timeoutMs, stdin }) => {
    log.info({ argv0: argv[0], args: argv.length - 1, cwd: cwd ?? null, stdinBytes: stdin?.length ?? 0 }, "spawn");
    const proc = Bun.spawn(argv, {
        cwd,
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
        // Its own process group, so the deadline ends everything the command started.
        detached: true,
    });
    const res = await collectOutput(proc, timeoutMs, { group: true });

    return res.timedOut
        ? { code: 124, stdout: res.stdout, stderr: `timed out after ${timeoutMs} ms\n${res.stderr}` }
        : { code: res.exitCode, stdout: res.stdout, stderr: res.stderr };
};

/** `tools <args>` through the worktree-safe `execTool`, in the same result shape as `spawnArgv`. */
export const execToolArgv: Runner = async (args, { cwd, timeoutMs, stdin }) => {
    log.info({ tool: args[0] ?? null, args: args.length, cwd: cwd ?? null, stdinBytes: stdin?.length ?? 0 }, "tools");
    const res = await execTool(args, { cwd, timeout: timeoutMs, stdin });

    return res.timedOut
        ? { code: 124, stdout: res.stdout, stderr: `timed out after ${timeoutMs} ms\n${res.stderr}` }
        : { code: res.exitCode, stdout: res.stdout, stderr: res.stderr };
};

/**
 * The runner for configured argv (agents, actions). A leading `tools` goes to `tools`, never to a
 * bare `$PATH` lookup that would run whichever checkout the PATH names; anything else is spawned.
 */
export function routedRunner({ tools, spawn }: { tools: Runner; spawn: Runner }): Runner {
    return (argv, opts) => (argv[0] === "tools" ? tools(argv.slice(1), opts) : spawn(argv, opts));
}

/** Main checkouts and worktrees under `repoRoots`, plus the repos the config maps by hand. */
export function configuredCheckouts(config: BrowserExtensionConfig): LocalCheckout[] {
    return [...discoverCheckouts({ roots: config.repoRoots }), ...Object.values(config.repos).flatMap(checkoutsAt)];
}

export function liveDeps(): Deps {
    return {
        config: loadConfig,
        checkouts: configuredCheckouts,
        run: routedRunner({ tools: execToolArgv, spawn: spawnArgv }),
        tools: (args, { cwd, timeoutMs }) => execToolArgv(args, { cwd, timeoutMs }),
        editor: editorDriver,
        terminal: terminalDriver,
        promptDir: join(browserExtensionStorage().getBaseDir(), "prompts"),
        now: () => new Date(),
    };
}
