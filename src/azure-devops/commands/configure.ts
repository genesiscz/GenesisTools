/**
 * Azure DevOps CLI Tool - Configure Command
 *
 * Handles the `configure` command for setting up Azure DevOps organization
 * and project configuration from any Azure DevOps URL.
 */

import { Command } from "commander";
import { $ } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import logger from "@app/logger";
import { Api, AZURE_DEVOPS_RESOURCE_ID } from "@app/azure-devops/api";
import { parseAzureDevOpsUrl, getLocalConfigDir } from "@app/azure-devops/utils";
import { exitWithAuthGuide } from "@app/azure-devops/cli.utils";
import type { AzureConfig } from "@app/azure-devops/types";

/**
 * Handle the configure command - parse URL, fetch project ID, and save config
 */
async function handleConfigure(url: string): Promise<void> {
  console.log("🔧 Configuring Azure DevOps CLI...\n");
  logger.debug(`[configure] Starting configuration with URL: ${url}`);

  // Check if logged in
  logger.debug("[configure] Checking Azure CLI login status...");
  try {
    await $`az account show`.quiet();
    logger.debug("[configure] Azure CLI is logged in");
  } catch {
    logger.debug("[configure] Azure CLI not logged in, showing auth guide");
    exitWithAuthGuide();
  }

  console.log(`Parsing URL: ${url}\n`);
  logger.debug("[configure] Parsing Azure DevOps URL...");

  const { org, project } = parseAzureDevOpsUrl(url);
  logger.debug(`[configure] Parsed org="${org}", project="${project}"`);

  console.log(`  Organization: ${org}`);
  console.log(`  Project: ${project}`);

  console.log("\nFetching project ID from API...");
  logger.debug("[configure] Fetching project ID via Azure DevOps API...");

  const projectId = await Api.getProjectId(org, project);
  logger.debug(`[configure] Got projectId="${projectId}"`);
  console.log(`  Project ID: ${projectId}`);

  const newConfig: AzureConfig = {
    org,
    project,
    projectId,
    apiResource: AZURE_DEVOPS_RESOURCE_ID,
  };

  // Save to local config directory (cwd)
  const configDir = getLocalConfigDir();
  logger.debug(`[configure] Config directory: ${configDir}`);
  if (!existsSync(configDir)) {
    logger.debug("[configure] Creating config directory...");
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = join(configDir, "config.json");
  logger.debug(`[configure] Writing config to: ${configPath}`);
  writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

  console.log(`\n✅ Configuration saved to: ${configPath}`);
  console.log("\nConfig values:");
  console.log("```json");
  console.log(JSON.stringify(newConfig, null, 2));
  console.log("```");

  // Configure az devops defaults
  console.log("\nConfiguring az devops defaults...");
  logger.debug(`[configure] Running: az devops configure --defaults organization=${org} project=${project}`);
  try {
    await $`az devops configure --defaults organization=${org} project=${project}`.quiet();
    logger.debug("[configure] az devops defaults configured successfully");
    console.log("✅ az devops defaults configured");
  } catch {
    logger.debug("[configure] Failed to configure az devops defaults");
    console.log("⚠️  Could not configure az devops defaults");
  }

  console.log(`
🎉 Done! You can now use the tool:

  tools azure-devops --query <id>
  tools azure-devops --workitem <id>
  tools azure-devops --dashboard <id>
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
