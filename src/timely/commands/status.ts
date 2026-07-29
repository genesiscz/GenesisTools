import type { TimelyApiClient } from "@app/timely/api/client";
import type { TimelyConfig } from "@app/timely/types";
import { readStoredCookie } from "@app/timely/utils/cookie";
import { describeTokenLifetime } from "@app/timely/utils/token-status";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
import chalk from "chalk";
import type { Command } from "commander";

export function registerStatusCommand(program: Command, storage: Storage, client: TimelyApiClient): void {
    program
        .command("status")
        .description("Show current configuration and auth status")
        .option("-f, --format <format>", "Output format: json, table", "table")
        .action(async (options) => {
            const config = await storage.getConfig<TimelyConfig>();
            // The cookie lives in its own 0600 file, not in the config object.
            const hasCookie = Boolean(await readStoredCookie(storage));

            if (options.format === "json") {
                // Mask sensitive data (guard against undefined config)
                const safeConfig = {
                    ...(config ?? {}),
                    oauth: config?.oauth ? { ...config.oauth, client_secret: "***" } : undefined,
                    tokens: config?.tokens
                        ? { ...config.tokens, access_token: "***", refresh_token: "***" }
                        : undefined,
                    cookie: hasCookie ? "***" : undefined,
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

            const lifetime = describeTokenLifetime(config);

            if (lifetime.kind === "known") {
                out.println(
                    `Token expires: ${lifetime.expiresAt.toISOString()} ${lifetime.expired ? chalk.red("(expired)") : ""}`
                );
            } else if (lifetime.kind === "fresh-login") {
                // Right after a login the unknown-lifetime line reads like a fault. It is not:
                // Timely just never sends expires_in, so the client always refreshes first.
                out.println(
                    `Token: ${chalk.green(`authenticated ${lifetime.age} ago`)}; lifetime unknown (no expires_in), refreshed on the next request`
                );
            } else if (lifetime.kind === "unknown") {
                // Timely often omits expires_in; the client then treats the token as
                // expired and refreshes, so say that rather than printing nothing.
                out.println(
                    `Token expires: ${chalk.yellow("unknown (no expires_in) - refreshed on the next request")}`
                );
            }

            // Memories credential (value never printed)
            if (hasCookie) {
                const updated = config?.cookieUpdatedAt
                    ? new Date(config.cookieUpdatedAt * 1000).toISOString()
                    : "unknown";
                out.println(`Memories cookie: ${chalk.green("stored")} (updated ${updated})`);
            } else {
                out.println(
                    `Memories cookie: ${chalk.red("not stored")} - run 'tools timely login cookies' for memories`
                );
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
