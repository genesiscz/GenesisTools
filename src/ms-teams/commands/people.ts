import { openCache } from "@app/ms-teams/lib/cache";
import { printPeople } from "@app/ms-teams/lib/display";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerPeopleCommand(program: Command): void {
    const people = program.command("people").description("List people from the Teams profile cache");

    people
        .argument("[query...]")
        .option("--json", "Machine-readable JSON")
        .action((queryParts: string[], opts: { json?: boolean }) => {
            runPeople((queryParts ?? []).join(" "), opts.json);
        });

    people
        .command("show [query...]")
        .description("Find people by name or email")
        .option("--json", "Machine-readable JSON")
        .action((queryParts: string[], opts: { json?: boolean }) => {
            runPeople((queryParts ?? []).join(" "), opts.json);
        });
}

function runPeople(query: string | undefined, json?: boolean): void {
    const cache = openCache();

    try {
        const rows = cache.listPeople(query || undefined);

        if (json) {
            out.result(rows);
            return;
        }

        if (rows.length === 0) {
            out.println("No people matched.");
            return;
        }

        printPeople(rows);
    } finally {
        cache.close();
    }
}
