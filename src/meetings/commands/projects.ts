import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { type MeetingsConfig, MeetingsConfigStore, sourceFolders } from "@genesiscz/utils/meetings/config";
import type { PersonRef } from "@genesiscz/utils/meetings/people";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { removeProject, renameProject } from "../lib/project-admin";
import { errorText, fail } from "../lib/shared";
import { matchPreviewRead, windowJson } from "../lib/window-reads";

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

        const table = createBoxTable(["PROJECT", "DICTIONARY", "LABELS", "MATCH"]);

        for (const [name, project] of Object.entries(config.projects)) {
            table.push([
                pc.white(name),
                String(project.dictionary?.entries.length ?? 0),
                project.labels.join(", ") || "—",
                matchSummary(config, name),
            ]);
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

async function rename(name: string, to: string, opts: { json?: boolean }): Promise<void> {
    try {
        const result = await renameProject({
            config: new MeetingsConfigStore(),
            store: new MeetingStore(),
            from: name,
            to,
        });

        if (opts.json) {
            out.result(SafeJSON.stringify(result, null, 2));
            return;
        }

        ui.ok(`Renamed the project ${name} to ${to}, with ${result.meetings.length} meetings.`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function remove(name: string, opts: { unassign?: boolean; json?: boolean }): Promise<void> {
    try {
        const result = await removeProject({
            config: new MeetingsConfigStore(),
            store: new MeetingStore(),
            name,
            unassign: opts.unassign,
        });

        if (opts.json) {
            out.result(SafeJSON.stringify(result, null, 2));
            return;
        }

        ui.ok(
            `Removed the project ${name}${result.unassigned.length ? `; ${result.unassigned.length} meetings have no project now` : ""}.`
        );
        ui.dim(`  its settings, dictionary and pairings: ${result.backup}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function labels(name: string, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    try {
        const store = new MeetingsConfigStore();
        const changes = (opts.add?.length ?? 0) + (opts.remove?.length ?? 0) > 0;
        // Without a change this only reads, so a typo never adds a project.
        const known = changes
            ? await store.setProjectLabels(name, opts)
            : ((await store.read()).projects[name]?.labels ?? []);
        ui.ok(`${name} labels: ${known.length > 0 ? known.join(", ") : "none"}`);
    } catch (err) {
        fail(errorText(err));
    }
}

/** "Alice Novak <alice@example.com>", "alice@example.com" or "Alice Novak". */
export function parsePerson(text: string): PersonRef {
    const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(text.trim());

    if (match) {
        return { name: match[1]?.trim() || match[2]!.trim(), email: match[2]!.trim() };
    }

    return text.includes("@") ? { name: text.trim(), email: text.trim() } : { name: text.trim() };
}

async function pair(name: string, opts: { person: string[]; note?: string }): Promise<void> {
    try {
        const people = opts.person.map(parsePerson);
        await new MeetingsConfigStore().pairPeople({
            project: name,
            people,
            by: { kind: "manual", at: new Date().toISOString(), ...(opts.note ? { note: opts.note } : {}) },
        });
        ui.ok(`Paired with ${name}: ${people.map((person) => person.name).join(", ")}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function unpair(name: string | undefined, opts: { entry?: string; person?: string }): Promise<void> {
    try {
        const store = new MeetingsConfigStore();

        if (opts.entry) {
            const removed = await store.unpairEntry(opts.entry);
            ui.ok(`Calendar entry ${opts.entry}: ${removed.length} pairing(s) removed.`);

            for (const person of removed) {
                ui.dim(
                    `  ${person.project}: ${person.name}${person.left ? " (left the project)" : " (another source still pairs them)"}`
                );
            }

            return;
        }

        if (!name || !opts.person) {
            fail(`Give --entry <calendar entry id>, or a project and --person <name|email>.`);
            return;
        }

        const removed = await store.unpairPerson(name, parsePerson(opts.person));
        ui.ok(removed ? `${opts.person} left ${name}.` : `${opts.person} was not paired with ${name}.`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function people(name: string | undefined, opts: { json?: boolean }): Promise<void> {
    try {
        const config = await new MeetingsConfigStore().read();
        const rows = Object.entries(config.projects)
            .filter(([project]) => !name || project === name)
            .flatMap(([project, settings]) => (settings.match?.people ?? []).map((person) => ({ project, ...person })));

        if (opts.json) {
            out.result(SafeJSON.stringify(rows, null, 2));
            return;
        }

        if (rows.length === 0) {
            ui.info(`No paired people${name ? ` in ${name}` : ""}. A confirmed calendar entry pairs its attendees.`);
            return;
        }

        const table = createBoxTable(["PROJECT", "PERSON", "PAIRED BY"]);

        for (const row of rows) {
            const by = row.pairedBy.map((source) =>
                source.kind === "manual"
                    ? "manual"
                    : `${source.title ?? source.entryId} (${source.entryId.slice(0, 12)})`
            );
            table.push([row.project, row.email ? `${row.name} <${row.email}>` : row.name, by.join("\n")]);
        }

        out.println(table.toString());
    } catch (err) {
        fail(errorText(err));
    }
}

async function preview(opts: { draft?: string; limit?: string; json?: boolean }): Promise<void> {
    try {
        const { draft, rows } = await matchPreviewRead(opts);

        if (opts.json) {
            out.result(windowJson(rows));
            return;
        }

        const table = createBoxTable(["MEETING", "HAS", "MATCHES NOW", ...(draft ? ["WITH THE DRAFT"] : [])]);

        for (const row of rows) {
            table.push([
                row.title,
                row.project ?? pc.dim("—"),
                row.now.join(", ") || pc.dim("—"),
                ...(draft ? [(row.changed ? pc.yellow : pc.dim)(row.draft.join(", ") || "—")] : []),
            ]);
        }

        out.println(table.toString());
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
    projects
        .command("rename")
        .argument("<name>", "the project name")
        .argument("<new-name>", "its new name")
        .description("Rename a project everywhere: its settings, dictionary, folder pairings and its meetings")
        .option("--json", "print { from, to, meetings } as JSON")
        .action(rename);
    projects
        .command("remove")
        .alias("rm")
        .argument("<name>", "the project name")
        .description("Remove a project, kept in a backup file first; refused while meetings have it")
        .option("--unassign", "leave the meetings that have it without a project")
        .option("--json", "print { name, unassigned, backup } as JSON")
        .action(remove);
    projects
        .command("labels")
        .argument("<name>", "the project name")
        .description("Show, add or remove the labels a meeting of this project can carry")
        .option("--add <label...>", "labels to add")
        .option("--remove <label...>", "labels to remove")
        .action(labels);
    projects
        .command("pair")
        .argument("<name>", "the project name")
        .description("Pair people with a project by hand; a later meeting with them proposes it")
        .requiredOption("--person <who...>", '"Name <email>", an email, or a name')
        .option("--note <text>", "why")
        .action(pair);
    projects
        .command("unpair")
        .argument("[name]", "the project name (with --person)")
        .description("Remove the pairings one calendar entry made (others stay), or one person from a project")
        .option("--entry <id>", "the calendar entry id (see projects people)")
        .option("--person <who>", '"Name <email>", an email, or a name')
        .action(unpair);
    projects
        .command("people")
        .argument("[name]", "only this project")
        .description("The people paired with each project and where each pairing came from")
        .option("--json", "print JSON")
        .action(people);
    projects
        .command("preview")
        .description("Which project each recent meeting matches by the rules, and with a draft of them; reads only")
        .option(
            "--draft <json>",
            '{"<project>":{"folders":{"wisprflow":["…"]},"calendars":["…"],"titleWords":["…"]}}: these rules instead of the saved ones'
        )
        .option("--limit <n>", "the newest meetings to check", "20")
        .option("--json", "print JSON")
        .action(preview);
}
