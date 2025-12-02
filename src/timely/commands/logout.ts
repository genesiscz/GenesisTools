import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import type { TimelyArgs, TimelyConfig } from "../types";

export async function logoutCommand(args: TimelyArgs, storage: Storage): Promise<void> {
    // Clear tokens from config
    const config = (await storage.getConfig<TimelyConfig>()) || {};
    delete config.tokens;
    delete config.user;

    await storage.setConfig(config);

    logger.info(chalk.green("Logged out successfully."));
}
