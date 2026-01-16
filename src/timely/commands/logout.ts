import { Command } from "commander";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import type { TimelyConfig } from "@app/timely/types";

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
