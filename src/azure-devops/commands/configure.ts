/**
 * Azure DevOps CLI Tool - Configure Command
 *
 * Handles the `configure` command for setting up Azure DevOps organization
 * and project configuration from any Azure DevOps URL.
 */

import { exitWithAuthGuide } from "@app/azure-devops/cli.utils";
import { buildAdoConfig, saveAdoConfig } from "@app/azure-devops/lib/ado-configure";
import { getLocalConfigDir } from "@app/azure-devops/utils";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { $ } from "bun";
import type { Command } from "commander";

async function handleConfigure(url: string): Promise<void> {
    console.log("🔧 Configuring Azure DevOps CLI...\n");
    logger.debug(`[configure] Starting configuration with URL: ${url}`);

    logger.debug("[configure] Checking Azure CLI login status...");
    try {
        await $`az account show`.quiet();
        logger.debug("[configure] Azure CLI is logged in");
    } catch {
        logger.debug("[configure] Azure CLI not logged in, showing auth guide");
        exitWithAuthGuide();
    }

    console.log(`Parsing URL and fetching project ID: ${url}\n`);

    const newConfig = await buildAdoConfig(url);
    logger.debug(`[configure] Config built: org="${newConfig.org}", project="${newConfig.project}", projectId="${newConfig.projectId}"`);

    console.log(`  Organization: ${newConfig.org}`);
    console.log(`  Project: ${newConfig.project}`);
    console.log(`  Project ID: ${newConfig.projectId}`);

    const configDir = getLocalConfigDir();
    const configPath = saveAdoConfig(newConfig, configDir);

    console.log(`\n✅ Configuration saved to: ${configPath}`);
    console.log("\nConfig values:");
    console.log("```json");
    console.log(SafeJSON.stringify(newConfig, null, 2));
    console.log("```");

    console.log("\nConfiguring az devops defaults...");
    try {
        await $`az devops configure --defaults organization=${newConfig.org} project=${newConfig.project}`.quiet();
        console.log("✅ az devops defaults configured");
    } catch {
        console.log("⚠️  Could not configure az devops defaults");
    }

    console.log(`
🎉 Done! You can now use the tool:

  tools azure-devops query <id>
  tools azure-devops workitem <id>
  tools azure-devops dashboard <id>
`);
}

/**
 * Register the configure command on the Commander program
 */
export function registerConfigureCommand(program: Command): void {
    program
        .command("configure <url>")
        .alias("config")
        .description("Configure Azure DevOps organization and project from any Azure DevOps URL")
        .action(async (url: string) => {
            await handleConfigure(url);
        });
}
