import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore, type ProjectConfig } from "@genesiscz/utils/meetings/config";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { errorText, fail } from "../lib/shared";

function matchSummary(project: ProjectConfig): string {
    const parts = [
        ...(project.match?.wisprflow?.folders ?? []).map((folder) => `wisprflow folder ${folder}`),
        ...(project.match?.calendar?.calendars ?? []).map((calendar) => `calendar ${calendar}`),
        ...(project.match?.calendar?.titles ?? []).map((word) => `title "${word}"`),
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
            table.push([pc.white(name), String(project.dictionary?.entries.length ?? 0), matchSummary(project)]);
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
