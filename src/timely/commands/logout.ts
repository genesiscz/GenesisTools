import type { TimelyConfig } from "@app/timely/types";
import { clearStoredCookie } from "@app/timely/utils/cookie";
import { logger } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
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
            delete config.authenticatedAt;

            await storage.setConfig(config);

            // The browser session is a second credential in its own file, and it keeps
            // working on its own. Logging out has to revoke it too, or "logged out"
            // leaves memories fully readable.
            const hadCookie = await clearStoredCookie(storage);

            logger.info(
                chalk.green(
                    hadCookie
                        ? "Logged out successfully. API tokens and the stored browser session cookie were both removed."
                        : "Logged out successfully."
                )
            );
        });
}
