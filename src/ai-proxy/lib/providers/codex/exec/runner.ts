#!/usr/bin/env bun
/**
 * The runner of Codex's `exec` tool in a Claude Code session on a Codex model. The proxy turns an `exec` call into a
 * Bash command that pipes the script into this file through a heredoc; see `bash-command.ts`.
 */
import { guardedExecCommand } from "@app/ai-proxy/lib/providers/codex/exec/exec-command";
import { shellGuard } from "@app/ai-proxy/lib/providers/codex/exec/guard";
import { runExecScript } from "@app/ai-proxy/lib/providers/codex/exec/script";
import { execStorePath, fileExecStore } from "@app/ai-proxy/lib/providers/codex/exec/store";
import { logger, setConsoleLevel } from "@genesiscz/utils/logger";

// Claude Code's Bash result carries stderr too, so a console log line would sit above Codex's `Script completed`
// header. The runner's logs go to the day log only.
setConsoleLevel("silent");

function sessionArg(argv: string[]): string | undefined {
    const index = argv.indexOf("--session");
    return index >= 0 ? argv[index + 1] : undefined;
}

const cwd = process.cwd();
const sessionId = sessionArg(process.argv.slice(2));
const source = await Bun.stdin.text();

logger.debug({ cwd, sessionId, chars: source.length }, "ai-proxy exec: running a script");

const output = await runExecScript({
    source,
    execCommand: guardedExecCommand({ guard: await shellGuard(), cwd }),
    store: fileExecStore(execStorePath(sessionId)),
});

process.stdout.write(output);
// Unawaited promises of the script end with it, as in Codex.
process.exit(0);
