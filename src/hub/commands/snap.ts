import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { snapToSession } from "../lib/snap/index";

/**
 * `tools hub snap <path>`: the phone's Snap it to the agent (`POST /api/snap`, F24): an uploaded photo onto the widget
 * shelf and into a session's draft.
 */
export function registerSnapCommand(program: Command): void {
    program
        .command("snap")
        .description("Put an uploaded photo onto the widget shelf and into a session's draft")
        .argument("<path>", "a file the dashboard's upload route stored")
        .requiredOption("--session <id>", "the session id")
        .requiredOption("--provider <id>", "claude, codex or grok")
        .option("--source-home <path>", "the session's source home (a worker session)")
        .option("--json", "machine-readable output")
        .action(
            async (path: string, opts: { session: string; provider: string; sourceHome?: string; json?: boolean }) => {
                const receipt = await snapToSession({
                    path,
                    provider: opts.provider,
                    sessionId: opts.session,
                    sourceHome: opts.sourceHome,
                });
                process.exitCode = receipt.attached ? 0 : 1;

                if (opts.json) {
                    out.result(receipt);
                    return;
                }

                out.log.info(receipt.error ?? `Attached to ${receipt.draftKey}`);
            }
        );
}
