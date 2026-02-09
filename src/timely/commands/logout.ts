import logger from "@app/logger";
import type { TimelyConfig } from "@app/timely/types";
import type { Storage } from "@app/utils/storage";
import chalk from "chalk";
import type { Command } from "commander";

export function registerLogoutCommand(program: Command, storage: Storage): void {
    program
        .command("logout")
        .description("Clear stored authentication tokens")
        .action(async () => {
            // Clear tokens from config
            const config = (await storage.getConfig<TimelyConfig>()) || {};
            delete config.tokens;
            delete config.user;

            await storage.setConfig(config);

            logger.info(chalk.green("Logged out successfully."));
        });
}
