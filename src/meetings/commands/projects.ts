import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { type MeetingsConfig, MeetingsConfigStore, sourceFolders } from "@genesiscz/utils/meetings/config";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { errorText, fail } from "../lib/shared";

function matchSummary(config: MeetingsConfig, name: string): string {
    const project = config.projects[name];
    const parts = [
        ...sourceFolders(config, name).map(({ source, folder }) => `${source} folder ${folder}`),
        ...(project?.match?.calendar?.calendars ?? []).map((calendar) => `calendar ${calendar}`),
        ...(project?.match?.title?.words ?? []).map((word) => `title "${word}"`),
        ...((project?.match?.people.length ?? 0) > 0 ? [`${project?.match?.people.length} people`] : []),
    ];
    return parts.join(", ") || "—";
}

async function listProjects(opts: { json?: boolean }): Promise<void> {
    const store = new MeetingsConfigStore();

    try {
        const config = await store.read();

        if (opts.json) {
            out.result(SafeJSON.stringify(config.projects, null, 2));
            return;
        }

        const names = Object.keys(config.projects);

        if (names.length === 0) {
            ui.info(`No known projects yet. Add one: ${toolCommand("meetings", "projects", "add")} <name>`);
            return;
        }

        const table = createBoxTable(["PROJECT", "DICTIONARY", "MATCH"]);

        for (const [name, project] of Object.entries(config.projects)) {
            table.push([pc.white(name), String(project.dictionary?.entries.length ?? 0), matchSummary(config, name)]);
        }

        out.println(table.toString());
        ui.dim(`config: ${store.path}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function addProject(name: string): Promise<void> {
    try {
        const added = await new MeetingsConfigStore().addProject(name);
        ui.ok(added ? `Added project ${name} to the known projects.` : `Project ${name} is known already.`);
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerProjectsCommand(program: Command): void {
    const projects = program.command("projects").description("The known projects a meeting can belong to");

    projects
        .command("list")
        .alias("ls")
        .description("List the known projects")
        .option("--json", "print JSON")
        .action(listProjects);
    projects
        .command("add")
        .argument("<name>", "the project name")
        .description("Add a known project")
        .action(addProject);
}
