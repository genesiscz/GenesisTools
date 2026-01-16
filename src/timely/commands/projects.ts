import { Command } from "commander";
import { select } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "@app/timely/api/service";
import type { TimelyProject, TimelyClient } from "@app/timely/types";

export function registerProjectsCommand(program: Command, storage: Storage, service: TimelyService): void {
    program
        .command("projects")
        .description("List all projects (--select to choose default)")
        .option("-f, --format <format>", "Output format: json, table", "table")
        .option("-s, --select", "Interactively select default project")
        .option("-a, --account <id>", "Override account ID")
        .action(async (options) => {
            try {
                await projectsAction(storage, service, options);
            } catch (error) {
                if (error instanceof ExitPromptError) {
                    logger.info("\nOperation cancelled.");
                    process.exit(0);
                }
                throw error;
            }
        });
}

interface ProjectsOptions {
    format?: string;
    select?: boolean;
    account?: string;
}

async function projectsAction(storage: Storage, service: TimelyService, options: ProjectsOptions): Promise<void> {
    // Get account ID
    const accountId = options.account
        ? parseInt(options.account, 10)
        : await storage.getConfigValue<number>("selectedAccountId");
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    // Fetch projects
    logger.info(chalk.yellow("Fetching projects..."));
    const projects = await service.getProjects(accountId);

    if (projects.length === 0) {
        logger.info("No projects found.");
        return;
    }

    // Save projects list to config
    await storage.setConfigValue("projects", projects);
    logger.debug(`Saved ${projects.length} project(s) to config`);

    // Output based on format
    if (options.format === "json") {
        console.log(JSON.stringify(projects, null, 2));
        return;
    }

    // Get currently selected project
    const selectedId = await storage.getConfigValue<number>("selectedProjectId");

    logger.info(chalk.cyan(`\nFound ${projects.length} project(s):\n`));

    // Group by client
    const byClient = new Map<string, TimelyProject[]>();
    for (const project of projects) {
        const client: TimelyClient | null = project.client;
        const clientName = client?.name || "No Client";
        if (!byClient.has(clientName)) {
            byClient.set(clientName, []);
        }
        byClient.get(clientName)!.push(project);
    }

    for (const [clientName, clientProjects] of byClient) {
        console.log(chalk.bold(clientName));
        for (const project of clientProjects) {
            const selected = project.id === selectedId ? chalk.green(" (selected)") : "";
            const status = project.active ? "" : chalk.gray("[inactive]");
            console.log(`  ${project.name} (ID: ${project.id}) ${status}${selected}`);
        }
        console.log();
    }

    // Interactive selection
    if (options.select) {
        const choices = projects
            .filter((p) => p.active)
            .map((p) => {
                const client: TimelyClient | null = p.client;
                return {
                    value: p.id.toString(),
                    name: `${p.name}${client ? ` (${client.name})` : ""}`,
                };
            });

        const projectId = await select({
            message: "Select default project:",
            choices,
        });

        await storage.setConfigValue("selectedProjectId", parseInt(projectId, 10));
        logger.info(chalk.green(`Default project set to ID: ${projectId}`));
    }
}
