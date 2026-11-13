import { runSessionCompaction, runSessionUse, type SessionUseOptions } from "@app/ai-proxy/commands/session-use";
import { runSessionCommand } from "@app/ai-proxy/commands/sessions";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

function collectValues(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface SessionCommandOptions extends SessionUseOptions {
    follow?: boolean;
    json?: boolean;
    marker?: string;
    from?: string;
    acknowledgeContextLoss?: boolean;
}

export function register(program: Command): void {
    program
        .command("session <id> [action]")
        .description(
            "One session: its record, then one row per request with cache read, write, hit % and losses. `use` switches its accounts (no restart)"
        )
        .option("-f, --follow", "Keep printing the session's new requests as they come")
        .option("--json", "Machine-readable output")
        .option("--codex <account>", "use: run the session's Codex turns on this login or proxy account")
        .option("--claude <account>", "use: run the session's Claude turns on this login or proxy account")
        .option("--grok <account>", "use: run the session's Grok turns on this login or proxy account")
        .option("--allow-metered <account>", "use: allow this per-token account (repeatable)", collectValues, [])
        .option("--marker <id>", "compaction-drop or compaction-restore: exact blocked compaction ID")
        .option("--from <file>", "compaction-restore: saved record file")
        .option("--acknowledge-context-loss", "compaction-drop: explicitly accept loss of the earlier context")
        .action(async (id: string, action: string | undefined, options: SessionCommandOptions) => {
            if (action === undefined) {
                runSessionCommand(id, options);
                return;
            }

            if (action === "compaction-drop" || action === "compaction-restore") {
                await runSessionCompaction(id, action, options);
                return;
            }

            if (action !== "use") {
                out.error(`Unknown session action "${action}". Try: ${toolCommand("ai-proxy session", id, "use")}`);
                process.exitCode = 1;
                return;
            }

            await runSessionUse(id, options);
        });
}
