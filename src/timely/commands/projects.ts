import Enquirer from "enquirer";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "../api/service";
import type { TimelyArgs, TimelyProject, TimelyClient } from "../types";

const prompter = new Enquirer();

export async function projectsCommand(args: TimelyArgs, storage: Storage, service: TimelyService): Promise<void> {
    // Get account ID
    const accountId = args.account || (await storage.getConfigValue<number>("selectedAccountId"));
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
    if (args.format === "json") {
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
    if (args.select) {
        const choices = projects
            .filter((p) => p.active)
            .map((p) => {
                const client: TimelyClient | null = p.client;
                return {
                    name: p.id.toString(),
                    message: `${p.name}${client ? ` (${client.name})` : ""}`,
                };
            });

        const { projectId } = (await prompter.prompt({
            type: "select",
            name: "projectId",
            message: "Select default project:",
            choices,
        })) as { projectId: string };

        await storage.setConfigValue("selectedProjectId", parseInt(projectId, 10));
        logger.info(chalk.green(`Default project set to ID: ${projectId}`));
    }
}
