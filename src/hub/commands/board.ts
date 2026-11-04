import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { agentsBoard } from "../lib/board/index";
import { stopAgentSession } from "../lib/board/stop";

function pidArg(value: string): number {
    const pid = Number(value);

    if (!Number.isInteger(pid) || pid <= 1) {
        throw new InvalidArgumentError("a pid above 1");
    }

    return pid;
}

/**
 * `tools hub board`: the live agent sessions as the phone's agents board shows them (`/api/gateway/board`), and
 * `tools hub board stop <key> --pid <pid>`, the same stop as the phone's Stop action (`POST /api/agents/stop`).
 */
export function registerBoardCommand(program: Command): void {
    const board = program
        .command("board")
        .description("Every live Claude, Codex and Grok session with its phase, stuck verdict, prompt and sub-agents")
        .option("--json", "machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const result = await agentsBoard();

            if (opts.json) {
                out.result(result);
                return;
            }

            renderCliHeader("Agents board", `${result.sessions.length} live session(s)`);
            const table = createBoxTable(["KEY", "PHASE", "PROJECT", "MODEL", "PID", "PROMPT"]);

            for (const session of result.sessions) {
                const phase = session.stalled ? pc.red(session.label) : session.label;
                table.push([
                    truncateDisplay(session.key, 28),
                    session.stuck ? `${phase} (${session.stuck.kind})` : phase,
                    truncateDisplay(session.project ?? "", 18),
                    truncateDisplay(session.model ?? "", 18),
                    session.pid === null ? "" : String(session.pid),
                    truncateDisplay(session.lastPrompt ?? "", 40),
                ]);
            }

            out.println(table.toString());
        });

    board
        .command("stop <key>")
        .description("End one live session's process tree (SIGTERM, then SIGKILL after the grace period)")
        .requiredOption("--pid <pid>", "the agent pid the board showed; a session on another pid is refused", pidArg)
        .option("--yes", "skip the confirmation")
        .option("--json", "machine-readable output")
        .action(async (key: string, opts: { pid: number; yes?: boolean; json?: boolean }) => {
            if (!opts.yes) {
                if (!isInteractive()) {
                    out.log.error("Non-interactive: pass --yes to stop a session.");
                    out.log.info(
                        suggestCommand("tools hub", {
                            replaceCommand: ["board", "stop", key, "--pid", String(opts.pid)],
                            add: ["--yes"],
                        })
                    );
                    process.exitCode = 2;
                    return;
                }

                const ok = await p.confirm({
                    message: `Stop ${key} (pid ${opts.pid}) and its tree?`,
                    initialValue: false,
                });

                if (p.isCancel(ok) || !ok) {
                    out.log.info("Cancelled. Nothing was signalled.");
                    process.exitCode = 1;
                    return;
                }
            }

            const receipt = await stopAgentSession({ key, pid: opts.pid });
            process.exitCode = receipt.stopped ? 0 : 1;

            if (opts.json) {
                out.result(receipt);
                return;
            }

            if (receipt.stopped) {
                out.log.success(`Stopped ${key} (${receipt.signal}).`);
                return;
            }

            out.log.error(`Not stopped: ${receipt.reason ?? "unknown"}`);
        });
}
