import { registerCaptureLifecycleCommands } from "@app/cmux/commands/capture-install";
import { renderCaptureShell } from "@app/cmux/lib/capture-shell";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerCaptureCommand(parent: Command): void {
    const capture = parent
        .command("capture")
        .description("Configure durable shell-command capture for offline restoration");
    registerCaptureLifecycleCommands(capture);
    capture
        .command("shell <shell>")
        .description("Print sourceable shell integration (currently zsh); does not edit shell configuration")
        .action((shell: string) => {
            if (shell !== "zsh") {
                throw new Error("Command capture currently supports zsh. Use: tools cmux capture shell zsh");
            }

            out.print(renderCaptureShell());
        });
}
