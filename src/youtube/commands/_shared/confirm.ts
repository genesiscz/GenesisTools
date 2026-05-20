import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import * as p from "@clack/prompts";
import pc from "picocolors";

export async function confirmDestructive(opts: {
    message: string;
    toolName?: string;
    assumeYesFlag?: string;
}): Promise<boolean> {
    if (!isInteractive()) {
        if (opts.assumeYesFlag) {
            out.error(pc.red(`Refusing to ${opts.message} without ${opts.assumeYesFlag} in non-interactive mode.`));
            out.error(
                `Re-run with: ${suggestCommand(opts.toolName ?? "tools youtube", { add: [opts.assumeYesFlag] })}`
            );
        } else {
            out.error(pc.red(`Refusing to ${opts.message} in non-interactive mode.`));
        }

        return false;
    }

    const answer = await p.confirm({ message: opts.message });

    return !p.isCancel(answer) && Boolean(answer);
}
