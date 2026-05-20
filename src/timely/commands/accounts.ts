import { logger, out } from "@app/logger";
import type { TimelyService } from "@app/timely/api/service";
import { SafeJSON } from "@app/utils/json";
import * as p from "@app/utils/prompts/p";
import type { Storage } from "@app/utils/storage";
import chalk from "chalk";
import type { Command } from "commander";

export function registerAccountsCommand(program: Command, storage: Storage, service: TimelyService): void {
    program
        .command("accounts")
        .description("List all accounts (--select to choose default)")
        .option("-f, --format <format>", "Output format: json, table", "table")
        .option("-s, --select", "Interactively select default account")
        .action(async (options) => {
            await accountsAction(storage, service, options);
        });
}

interface AccountsOptions {
    format?: string;
    select?: boolean;
}

async function accountsAction(storage: Storage, service: TimelyService, options: AccountsOptions): Promise<void> {
    // Fetch accounts
    logger.info(chalk.yellow("Fetching accounts..."));
    const accounts = await service.getAccounts();

    if (accounts.length === 0) {
        logger.info("No accounts found.");
        return;
    }

    // Save accounts list to config
    await storage.setConfigValue("accounts", accounts);
    logger.debug(`Saved ${accounts.length} account(s) to config`);

    // Get currently selected account
    const selectedId = await storage.getConfigValue<number>("selectedAccountId");

    // Display accounts
    if (options.format === "json") {
        out.println(SafeJSON.stringify(accounts, null, 2));
        return;
    }

    logger.info(chalk.cyan(`\nFound ${accounts.length} account(s):\n`));

    for (const account of accounts) {
        const selected = account.id === selectedId ? chalk.green(" (selected)") : "";
        const status = account.expired ? chalk.red("[expired]") : account.trial ? chalk.yellow("[trial]") : "";
        out.println(`  ${chalk.bold(account.name)} (ID: ${account.id}) ${status}${selected}`);
        out.println(`    Plan: ${account.plan_name}`);
        out.println(`    Users: ${account.num_users}/${account.max_users}`);
        out.println(`    Projects: ${account.active_projects_count}/${account.max_projects}`);
        out.println();
    }

    // Interactive selection
    if (options.select || !selectedId) {
        const choices = accounts.map((a) => ({
            value: a.id.toString(),
            name: `${a.name} (${a.plan_name})`,
        }));

        const accountId = (await p.select({
            message: "Select default account:",
            options: choices.map((c) => ({ value: c.value, label: c.name })),
        })) as string;

        await storage.setConfigValue("selectedAccountId", parseInt(accountId, 10));
        logger.info(chalk.green(`Default account set to ID: ${accountId}`));
    }
}
