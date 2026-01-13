import { Command } from "commander";
import chalk from "chalk";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "../api/client";
import type { TimelyConfig } from "../types";

export function registerStatusCommand(program: Command, storage: Storage, client: TimelyApiClient): void {
    program
        .command("status")
        .description("Show current configuration and auth status")
        .option("-f, --format <format>", "Output format: json, table", "table")
        .action(async (options) => {
            const config = await storage.getConfig<TimelyConfig>();

            if (options.format === "json") {
                // Mask sensitive data
                const safeConfig = {
                    ...config,
                    oauth: config?.oauth ? { ...config.oauth, client_secret: "***" } : undefined,
                    tokens: config?.tokens
                        ? { ...config.tokens, access_token: "***", refresh_token: "***" }
                        : undefined,
                };
                console.log(JSON.stringify(safeConfig, null, 2));
                return;
            }

            console.log(chalk.cyan("\nTimely CLI Status\n"));

            // Authentication status
            const isAuth = await client.isAuthenticated();
            console.log(`Authentication: ${isAuth ? chalk.green("Logged in") : chalk.red("Not logged in")}`);

            if (config?.user) {
                console.log(`User: ${config.user.name} (${config.user.email})`);
            }

            if (config?.tokens?.created_at && config?.tokens?.expires_in) {
                const expiresAt = new Date((config.tokens.created_at + config.tokens.expires_in) * 1000);
                const isExpired = Date.now() > expiresAt.getTime();
                console.log(`Token expires: ${expiresAt.toISOString()} ${isExpired ? chalk.red("(expired)") : ""}`);
            }

            // Selected account/project
            console.log();
            console.log(`Selected Account ID: ${config?.selectedAccountId || chalk.gray("(none)")}`);
            console.log(`Selected Project ID: ${config?.selectedProjectId || chalk.gray("(none)")}`);

            // Cache stats
            const cacheStats = await storage.getCacheStats();
            console.log();
            console.log(`Cache files: ${cacheStats.count}`);
            console.log(`Cache size: ${(cacheStats.totalSizeBytes / 1024).toFixed(1)} KB`);

            // Config location
            console.log();
            console.log(chalk.gray(`Config: ${storage.getConfigPath()}`));
            console.log(chalk.gray(`Cache: ${storage.getCacheDir()}`));
        });
}
