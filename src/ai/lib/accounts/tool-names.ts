import type { LoginNextStep } from "@genesiscz/utils/ai/providers/account-features";
import { suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";

/** The command a login variant's `nextStep` names, with this checkout's binary in front of its tool. */
export function nextStepCommand(next: LoginNextStep): string {
    return suggestCommand(toolCommand(next.tool), {
        ...(next.replaceCommand ? { replaceCommand: next.replaceCommand } : {}),
        ...(next.add ? { add: next.add } : {}),
    });
}

/**
 * The sibling command name for a door, e.g. `tools claude login` from
 * `tools claude login-long`.
 *
 * A door names itself with its own verb (`tools ai accounts login-secondary`),
 * so a message that points at `login` cannot just append the word: doing that
 * printed `Run tools claude login-long login first` where the old command said
 * `Run tools claude login first` (gap/cli).
 */
export function siblingCommandOf(tool: string, verb: string): string {
    const trimmed = tool.trim();
    const cut = trimmed.lastIndexOf(" ");

    if (cut < 0) {
        return `${trimmed} ${verb}`;
    }

    return `${trimmed.slice(0, cut)} ${verb}`;
}
