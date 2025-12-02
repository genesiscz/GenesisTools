import Enquirer from "enquirer";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "../api/service";
import type { TimelyArgs, TimelyAccount } from "../types";

const prompter = new Enquirer();

export async function accountsCommand(args: TimelyArgs, storage: Storage, service: TimelyService): Promise<void> {
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
    if (args.format === "json") {
        console.log(JSON.stringify(accounts, null, 2));
        return;
    }

    logger.info(chalk.cyan(`\nFound ${accounts.length} account(s):\n`));

    for (const account of accounts) {
        const selected = account.id === selectedId ? chalk.green(" (selected)") : "";
        const status = account.expired ? chalk.red("[expired]") : account.trial ? chalk.yellow("[trial]") : "";
        console.log(`  ${chalk.bold(account.name)} (ID: ${account.id}) ${status}${selected}`);
        console.log(`    Plan: ${account.plan_name}`);
        console.log(`    Users: ${account.num_users}/${account.max_users}`);
        console.log(`    Projects: ${account.active_projects_count}/${account.max_projects}`);
        console.log();
    }

    // Interactive selection
    if (args.select || !selectedId) {
        const choices = accounts.map((a) => ({
            name: a.id.toString(),
            message: `${a.name} (${a.plan_name})`,
        }));

        const { accountId } = (await prompter.prompt({
            type: "select",
            name: "accountId",
            message: "Select default account:",
            choices,
        })) as { accountId: string };

        await storage.setConfigValue("selectedAccountId", parseInt(accountId, 10));
        logger.info(chalk.green(`Default account set to ID: ${accountId}`));
    }
}
