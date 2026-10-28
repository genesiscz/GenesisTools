import { suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";

/** A `tools ai-proxy <args>` line to print as the next step. */
export function aiProxyCommand(replaceCommand: string[]): string {
    return suggestCommand("tools ai-proxy", { replaceCommand });
}

export const HOT_RELOAD_HINT = "The running proxy re-reads config.json on its next request — no restart needed.";

export const RESTART_HINT = `Restart the proxy to apply: ${toolCommand("ai-proxy down")} && ${toolCommand("ai-proxy up")}`;
