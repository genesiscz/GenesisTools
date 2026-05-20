import { out } from "@app/logger";
import type { TimelyApiClient } from "@app/timely/api/client";
import type { TimelyConfig } from "@app/timely/types";
import { SafeJSON } from "@app/utils/json";
import type { Storage } from "@app/utils/storage";
import chalk from "chalk";
import type { Command } from "commander";

export function registerStatusCommand(program: Command, storage: Storage, client: TimelyApiClient): void {
    program
        .command("status")
        .description("Show current configuration and auth status")
        .option("-f, --format <format>", "Output format: json, table", "table")
        .action(async (options) => {
            const config = await storage.getConfig<TimelyConfig>();

            if (options.format === "json") {
                // Mask sensitive data (guard against undefined config)
                const safeConfig = {
                    ...(config ?? {}),
                    oauth: config?.oauth ? { ...config.oauth, client_secret: "***" } : undefined,
                    tokens: config?.tokens
                        ? { ...config.tokens, access_token: "***", refresh_token: "***" }
                        : undefined,
                };
                out.println(SafeJSON.stringify(safeConfig, null, 2));
                return;
            }

            out.println(chalk.cyan("\nTimely CLI Status\n"));

            // Authentication status
            const isAuth = await client.isAuthenticated();
            out.println(`Authentication: ${isAuth ? chalk.green("Logged in") : chalk.red("Not logged in")}`);

            if (config?.user) {
                out.println(`User: ${config.user.name} (${config.user.email})`);
            }

            if (config?.tokens?.created_at && config?.tokens?.expires_in) {
                const expiresAt = new Date((config.tokens.created_at + config.tokens.expires_in) * 1000);
                const isExpired = Date.now() > expiresAt.getTime();
                out.println(`Token expires: ${expiresAt.toISOString()} ${isExpired ? chalk.red("(expired)") : ""}`);
            }

            // Selected account/project
            out.println();
            out.println(`Selected Account ID: ${config?.selectedAccountId || chalk.gray("(none)")}`);
            out.println(`Selected Project ID: ${config?.selectedProjectId || chalk.gray("(none)")}`);

            // Cache stats
            const cacheStats = await storage.getCacheStats();
            out.println();
            out.println(`Cache files: ${cacheStats.count}`);
            out.println(`Cache size: ${(cacheStats.totalSizeBytes / 1024).toFixed(1)} KB`);

            // Config location
            out.println();
            out.println(chalk.gray(`Config: ${storage.getConfigPath()}`));
            out.println(chalk.gray(`Cache: ${storage.getCacheDir()}`));
        });
}
