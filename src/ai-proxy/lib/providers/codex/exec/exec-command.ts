import { EXEC_BASH_TIMEOUT_MS } from "@app/ai-proxy/lib/providers/codex/exec/bash-command";
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
    if (maxChars <= marker(text.length).length) {
        return { text: marker(text.length).slice(0, Math.max(0, maxChars)), truncated: true };
    }

    const room = Math.max(0, maxChars - marker(text.length).length);
    const head = Math.ceil(room / 2);
    const tail = room - head;
    const cut = text.length - head - tail;

    return { text: `${text.slice(0, head)}${marker(cut)}${tail > 0 ? text.slice(-tail) : ""}`, truncated: true };
}

/** Retains only a bounded prefix and suffix while counting every decoded character. */
export class BoundedOutput {
    private head = "";
    private tail = "";
    length = 0;

    constructor(private readonly limit: number) {}

    append(value: string): void {
        this.length += value.length;
        const missing = Math.max(0, this.limit - this.head.length);
        this.head += value.slice(0, missing);
        this.tail = (this.tail + value.slice(-this.limit)).slice(-this.limit);
    }

    result(): { text: string; truncated: boolean } {
        if (this.length <= this.limit) {
            return { text: this.head, truncated: false };
        }

        const marker = `\n…${this.length} chars truncated…\n`;
        if (marker.length >= this.limit) {
            return { text: marker.slice(0, this.limit), truncated: true };
        }

        const room = this.limit - marker.length;
        const headLength = Math.ceil(room / 2);
        const tailLength = room - headLength;
        const actualMarker = `\n…${this.length - room} chars truncated…\n`;
        return {
            text: this.head.slice(0, headLength) + actualMarker + (tailLength ? this.tail.slice(-tailLength) : ""),
            truncated: true,
        };
    }
}

/** Drain both pipes concurrently, retaining a bounded output sample. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, chunks: BoundedOutput): Promise<void> {
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.append(decoder.decode(value, { stream: true }));
    }

    const rest = decoder.decode();

    if (rest.length > 0) {
        chunks.append(rest);
    }
}

/** Runs one command to its end in a shell, with no PTY and no stdin, and returns Codex's result shape. */
export async function runShellCommand(
    args: ExecCommandArgs,
    options: { cwd: string; deadlineAt?: number; supervisorShell?: string }
): Promise<ExecCommandResult> {
    const startedAt = performance.now();
    const shell = args.shell ?? env.paths.getShell();
    const cwd = args.workdir ?? options.cwd;
    const deadlineAt = options.deadlineAt ?? startedAt + EXEC_BASH_TIMEOUT_MS - 10_000;
    if (deadlineAt <= performance.now()) {
        throw new Error("exec_command failed: the script deadline expired before the command started");
    }
    // The watcher remains in the owned group, pinning its identity until the control pipe closes.
    // Only an explicit normal-completion message suppresses cleanup on timeout or parent death.
    // Dash replaces a background job's stdin before <&0; descriptor 3 keeps the control pipe available.
    const supervisor =
        'exec 3<&0; group=$$; (IFS= read -r action; if [ "$action" != done ]; then kill -KILL -"$group"; fi) <&3 >/dev/null 2>&1 & watcher=$!; exec 3<&-; "$@" </dev/null & child=$!; wait "$child"; status=$?; exec 1>&- 2>&-; wait "$watcher"; exit "$status"';
    const proc = Bun.spawn(
        [
            options.supervisorShell ?? "/bin/sh",
            "-c",
            supervisor,
            "exec-supervisor",
            shell,
            args.login === true ? "-lc" : "-c",
            args.cmd,
        ],
        {
            cwd,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
        }
    );
    const requestedTokens = args.max_output_tokens ?? DEFAULT_COMMAND_TOKENS;
    const maxChars = Math.min(
        1_000_000,
        Math.max(1, Number.isFinite(requestedTokens) ? requestedTokens : DEFAULT_COMMAND_TOKENS) * CHARS_PER_TOKEN
    );
    const chunks = new BoundedOutput(maxChars);

    const stdout = proc.stdout.getReader();
    const stderr = proc.stderr.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadlineAt - performance.now()));
    });
    const finished = Promise.all([drain(stdout, chunks), drain(stderr, chunks)]).then(async () => {
        await proc.stdin.write("done\n");
        await proc.stdin.end();
        return proc.exited;
    });
    let exitCode: number;
    try {
        const result = await Promise.race([finished, timeout]);
        if (result === null) {
            try {
                await proc.stdin.write("stop\n");
                await proc.stdin.end();
            } catch (error) {
                logger.debug({ error }, "ai-proxy exec: group watcher was unavailable");
            }
            void stdout.cancel().catch((error) => logger.debug({ error }, "ai-proxy exec: stdout cancellation failed"));
            void stderr.cancel().catch((error) => logger.debug({ error }, "ai-proxy exec: stderr cancellation failed"));
            throw new Error(
                "exec_command failed: the script deadline expired; group cleanup may be incomplete if its watcher exited"
            );
        }
        exitCode = result;
    } finally {
        clearTimeout(timer);
    }
    const cut = chunks.result();

    logger.debug({ cwd, shell, exitCode, chars: chunks.length }, "ai-proxy exec: ran a nested command");

    return {
        output: cut.text,
        exit_code: exitCode,
        wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
        ...(cut.truncated ? { original_token_count: Math.ceil(chunks.length / CHARS_PER_TOKEN) } : {}),
    };
}

/** `tools.exec_command`: the shell guard first, then the command; a block throws the error the script sees. */
export function guardedExecCommand({
    guard,
    cwd,
    deadlineAt,
    run = (args) => runShellCommand(args, { cwd, deadlineAt }),
}: {
    guard: CommandGuard;
    cwd: string;
    deadlineAt?: number;
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
