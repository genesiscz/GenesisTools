#!/usr/bin/env bun
/**
 * The runner of Codex's `exec` tool in a Claude Code session on a Codex model. The proxy turns an `exec` call into a
 * Bash command that pipes the script into this file through a heredoc; see `bash-command.ts`.
 */
import { EXEC_BASH_TIMEOUT_MS } from "@app/ai-proxy/lib/providers/codex/exec/bash-command";
import { guardedExecCommand } from "@app/ai-proxy/lib/providers/codex/exec/exec-command";
import { shellGuard } from "@app/ai-proxy/lib/providers/codex/exec/guard";
import { runExecScript } from "@app/ai-proxy/lib/providers/codex/exec/script";
import { execStorePath, fileExecStore, memoryExecStore } from "@app/ai-proxy/lib/providers/codex/exec/store";
import { logger, setConsoleLevel } from "@genesiscz/utils/logger";

// Claude Code's Bash result carries stderr too, so a console log line would sit above Codex's `Script completed`
// header. The runner's logs go to the day log only.
setConsoleLevel("silent");

function sessionArg(argv: string[]): string | undefined {
    const index = argv.indexOf("--session");
    return index >= 0 ? argv[index + 1] : undefined;
}

const deadlineAt = performance.now() + EXEC_BASH_TIMEOUT_MS - 10_000;
const cwd = process.cwd();
const argv = process.argv.slice(2);
const sessionId = sessionArg(argv);
const modelIndex = argv.indexOf("--model");
const model = modelIndex >= 0 ? argv[modelIndex + 1] : undefined;
const source = await Bun.stdin.text();

logger.debug({ cwd, sessionId, chars: source.length }, "ai-proxy exec: running a script");

// This process runs exactly one script. Discard its unawaited rejections without affecting the proxy process.
const discardUnhandled = () => logger.debug("ai-proxy exec: discarded an unawaited rejection");
process.on("unhandledRejection", discardUnhandled);
try {
    const output = await runExecScript({
        source,
        execCommand: guardedExecCommand({ guard: await shellGuard({ model }), cwd, deadlineAt }),
        store:
            sessionId && sessionId !== "no-session" && /^[A-Za-z0-9_-]+$/.test(sessionId)
                ? fileExecStore(execStorePath(sessionId))
                : memoryExecStore(),
    });

    await new Promise<void>((resolve, reject) => {
        process.stdout.write(output, (error) => (error ? reject(error) : resolve()));
    });
} finally {
    process.off("unhandledRejection", discardUnhandled);
}
// Unawaited promises of the script end with it, as in Codex.
process.exit(0);
