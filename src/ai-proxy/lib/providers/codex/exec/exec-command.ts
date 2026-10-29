import type {
    CommandGuard,
    ExecCommand,
    ExecCommandArgs,
    ExecCommandResult,
} from "@app/ai-proxy/lib/providers/codex/exec/types";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

/** Codex's own estimate: a token is about 4 characters. */
export const CHARS_PER_TOKEN = 4;
/** Codex's default `max_output_tokens` for one `exec_command`. */
const DEFAULT_COMMAND_TOKENS = 10_000;

/** A text cut to `maxChars` with the middle left out, the way Codex truncates a command's output. */
export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) {
        return { text, truncated: false };
    }

    const marker = (cut: number) => `\n…${cut} chars truncated…\n`;
    const room = Math.max(0, maxChars - marker(text.length).length);
    const head = Math.ceil(room / 2);
    const tail = room - head;
    const cut = text.length - head - tail;

    return { text: `${text.slice(0, head)}${marker(cut)}${tail > 0 ? text.slice(-tail) : ""}`, truncated: true };
}

/** Reads a stream into `chunks` as it arrives, so stdout and stderr interleave the way a terminal shows them. */
async function drain(stream: ReadableStream<Uint8Array>, chunks: string[]): Promise<void> {
    const decoder = new TextDecoder();

    for await (const chunk of stream) {
        chunks.push(decoder.decode(chunk, { stream: true }));
    }

    const rest = decoder.decode();

    if (rest.length > 0) {
        chunks.push(rest);
    }
}

/** Runs one command to its end in a shell, with no PTY and no stdin, and returns Codex's result shape. */
export async function runShellCommand(args: ExecCommandArgs, options: { cwd: string }): Promise<ExecCommandResult> {
    const startedAt = performance.now();
    const shell = args.shell ?? env.paths.getShell();
    const cwd = args.workdir ?? options.cwd;
    const proc = Bun.spawn([shell, args.login === true ? "-lc" : "-c", args.cmd], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const chunks: string[] = [];

    await Promise.all([drain(proc.stdout, chunks), drain(proc.stderr, chunks)]);
    const exitCode = await proc.exited;
    const output = chunks.join("");
    const maxChars = Math.max(1, args.max_output_tokens ?? DEFAULT_COMMAND_TOKENS) * CHARS_PER_TOKEN;
    const cut = truncateMiddle(output, maxChars);

    logger.debug({ cwd, shell, exitCode, chars: output.length }, "ai-proxy exec: ran a nested command");

    return {
        output: cut.text,
        exit_code: exitCode,
        wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
        ...(cut.truncated ? { original_token_count: Math.ceil(output.length / CHARS_PER_TOKEN) } : {}),
    };
}

/** `tools.exec_command`: the shell guard first, then the command; a block throws the error the script sees. */
export function guardedExecCommand({
    guard,
    cwd,
    run = (args) => runShellCommand(args, { cwd }),
}: {
    guard: CommandGuard;
    cwd: string;
    run?: ExecCommand;
}): ExecCommand {
    return async (args) => {
        const check = guard.check(args.cmd, args.workdir ?? cwd);

        if (check.outcome === "block") {
            logger.info({ rules: check.rules }, "ai-proxy exec: the shell guard blocked a nested command");
            throw new Error(`exec_command failed: the shell guard blocked this command.\n${check.message}`);
        }

        const result = await run(args);

        return check.outcome === "warn" ? { ...result, guard_warning: check.message } : result;
    };
}
