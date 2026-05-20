/**
 * Azure DevOps CLI Tool - Configure Command
 *
 * Handles the `configure` command for setting up Azure DevOps organization
 * and project configuration from any Azure DevOps URL.
 */

import { exitWithAuthGuide } from "@app/azure-devops/cli.utils";
import { buildAdoConfig, saveAdoConfig } from "@app/azure-devops/lib/ado-configure";
import { getLocalConfigDir } from "@app/azure-devops/utils";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { $ } from "bun";
import type { Command } from "commander";

async function handleConfigure(url: string): Promise<void> {
    out.print("🔧 Configuring Azure DevOps CLI...\n");
    logger.debug(`[configure] Starting configuration with URL: ${url}`);

    logger.debug("[configure] Checking Azure CLI login status...");
    try {
        await $`az account show`.quiet();
        logger.debug("[configure] Azure CLI is logged in");
    } catch {
        logger.debug("[configure] Azure CLI not logged in, showing auth guide");
        exitWithAuthGuide();
    }

    // Check if azure-devops extension is installed
    try {
        const extList = await $`az extension list --query "[?name=='azure-devops'].name" -o tsv`.quiet();

        if (!extList.text().trim()) {
            out.print(
                "⚠️  Azure DevOps CLI extension not installed. Install it with:\n\n" +
                    "    az extension add --name azure-devops\n"
            );
        }
    } catch {
        logger.debug("[configure] Could not check azure-devops extension status");
    }

    out.print(`Parsing URL and fetching project ID: ${url}\n`);

    const newConfig = await buildAdoConfig(url);
    logger.debug(
        `[configure] Config built: org="${newConfig.org}", project="${newConfig.project}", projectId="${newConfig.projectId}"`
    );

    out.print(`  Organization: ${newConfig.org}`);
    out.print(`  Project: ${newConfig.project}`);
    out.print(`  Project ID: ${newConfig.projectId}`);

    const configDir = getLocalConfigDir();
    const configPath = saveAdoConfig(newConfig, configDir);

    out.print(`\n✅ Configuration saved to: ${configPath}`);
    out.print("\nConfig values:");
    out.print("```json");
    out.print(SafeJSON.stringify(newConfig, null, 2));
    out.print("```");

    out.print("\nConfiguring az devops defaults...");
    try {
        const result =
            await $`az devops configure --defaults organization=${newConfig.org} project=${newConfig.project}`
                .quiet()
                .nothrow();

        if (result.exitCode === 0) {
            out.print("✅ az devops defaults configured");
        } else {
            const stderr = result.stderr.toString().trim();
            const stdout = result.stdout.toString().trim();
            out.print(`⚠️  Could not configure az devops defaults (exit ${result.exitCode})`);

            if (stderr) {
                out.print(`   stderr: ${stderr}`);
            }

            if (stdout) {
                out.print(`   stdout: ${stdout}`);
            }

            out.print(
                `   You can run this manually:\n     az devops configure --defaults organization="${newConfig.org}" project="${newConfig.project}"`
            );
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.print(`⚠️  Could not configure az devops defaults: ${message}`);
        out.print(
            `   You can run this manually:\n     az devops configure --defaults organization="${newConfig.org}" project="${newConfig.project}"`
        );
    }

    out.print(`
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
