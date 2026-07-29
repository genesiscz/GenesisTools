import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { registerAccountCommands } from "./account";
import { registerDefaultCommands } from "./defaults";
import { registerLinkCommands } from "./link";
import { registerSecretCommands } from "./secret";

/**
 * Mount `tools ai config` and its subtree.
 *
 * The provider registry is populated here rather than lazily inside each
 * command, so `--help` can name real provider ids and a typo fails before any
 * write.
 */
export function registerConfigCommands(command: Command, onInteractive: () => Promise<void>): void {
    registerBuiltInPlugins();

    const config = command
        .command("config")
        .description("Manage AI accounts, defaults, links, secrets and diagnostics")
        .action(async () => {
            if (!isInteractive()) {
                out.log.error("tools ai config with no arguments opens an interactive menu, which needs a TTY.");
                out.log.info(suggestCommand("tools ai config", { add: ["--help"] }));
                process.exitCode = 1;
                return;
            }

            await onInteractive();
        });

    registerAccountCommands(config);
    registerDefaultCommands(config);
    registerLinkCommands(config);
    registerSecretCommands(config);
}
