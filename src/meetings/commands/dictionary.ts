import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { type DictionaryScope, MeetingsConfigStore, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { readCorrections } from "@genesiscz/utils/meetings/corrections";
import { MEETING_SOURCE_IDS } from "@genesiscz/utils/meetings/sources";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { ABBR_EXPANSIONS, type DictionaryEntry, dictionaryEntrySchema } from "@genesiscz/utils/transcribe/dictionary";
import type { Command } from "commander";
import pc from "picocolors";
import { suggestDictionary } from "../lib/dictionary-suggest";
import { testPhrase } from "../lib/dictionary-test";
import { errorText, fail, resolveEnum } from "../lib/shared";
import { isMeetingSourceId, meetingSource } from "../lib/sources";

const ENTRY_TYPES = ["fix", "abbr", "term", "keep"] as const;

async function show(opts: { project?: string; json?: boolean }): Promise<void> {
    const store = new MeetingsConfigStore();

    try {
        const config = await store.read();

        if (opts.project && !config.projects[opts.project]) {
            const known = Object.keys(config.projects).join(", ") || "none yet";
            fail(
                `Unknown project ${opts.project}. Known: ${known}. Add it: ${toolCommand("meetings", "projects", "add", opts.project)}`
            );
            return;
        }

        const merged = resolveDictionary(config, { project: opts.project });
        const projectValues = new Set(
            (opts.project ? config.projects[opts.project]?.dictionary?.entries : [])?.map((entry) => entry.value)
        );
        const rows = merged.entries.map((entry) => ({
            ...entry,
            level: projectValues.has(entry.value) ? `project ${opts.project}` : "global",
        }));

        if (opts.json) {
            out.result(
                SafeJSON.stringify(
                    { project: opts.project ?? null, abbrExpansion: merged.abbrExpansion, entries: rows },
                    null,
                    2
                )
            );
            return;
        }

        const table = createBoxTable(["TYPE", "VALUE", "SUBSTITUTION", "LEVEL"]);

        for (const row of rows) {
            const substitution =
                "substitution" in row
                    ? row.substitution
                    : "spoken" in row && row.spoken
                      ? `spoken: ${row.spoken.join(", ")}`
                      : "—";
            table.push([row.type, pc.white(row.value), truncateDisplay(substitution, 60), row.level]);
        }

        out.println(table.toString());
        ui.dim(`abbreviations expand: ${merged.abbrExpansion} · config: ${store.path}`);
    } catch (err) {
        fail(errorText(err));
    }
}

function scopeOf(project: string | undefined): DictionaryScope {
    return project ? { kind: "project", project } : { kind: "global" };
}

async function add(
    value: string,
    substitution: string | undefined,
    opts: { type?: string | boolean; project?: string; spoken?: string[]; meaning?: string; caseSensitive?: boolean }
): Promise<void> {
    const type = await resolveEnum({
        value: opts.type,
        values: ENTRY_TYPES,
        flag: "--type",
        subcommand: ["dictionary", "add"],
    });

    if (!type) {
        return;
    }

    const candidate =
        type === "fix"
            ? { type, value, substitution, ...(opts.caseSensitive ? { caseSensitive: true } : {}) }
            : type === "abbr"
              ? { type, value, substitution }
              : type === "term"
                ? {
                      type,
                      value,
                      ...(opts.spoken?.length ? { spoken: opts.spoken } : {}),
                      ...(opts.meaning ? { meaning: opts.meaning } : {}),
                  }
                : { type, value };
    const parsed = dictionaryEntrySchema.safeParse(candidate);

    if (!parsed.success) {
        fail(`A ${type} entry needs ${type === "fix" || type === "abbr" ? "a value and a substitution" : "a value"}.`);
        return;
    }

    const entry: DictionaryEntry = parsed.data;
    const store = new MeetingsConfigStore();

    try {
        if (opts.project && (await store.addProject(opts.project))) {
            ui.ok(`Added project ${opts.project} to the known projects.`);
        }

        await store.putDictionaryEntry(scopeOf(opts.project), entry);
        ui.ok(
            `${entry.type} ${entry.value} saved to the ${opts.project ? `project ${opts.project}` : "global"} dictionary.`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

async function remove(value: string, opts: { project?: string }): Promise<void> {
    try {
        const removed = await new MeetingsConfigStore().removeDictionaryEntry(scopeOf(opts.project), value);
        const level = opts.project ? `project ${opts.project}` : "global";

        if (removed) {
            ui.ok(`Removed ${value} from the ${level} dictionary.`);
        } else {
            fail(`${value} is not in the ${level} dictionary.`);
        }
    } catch (err) {
        fail(errorText(err));
    }
}

async function expansion(mode: string | undefined, opts: { project?: string }): Promise<void> {
    const picked = await resolveEnum({
        value: mode,
        values: ABBR_EXPANSIONS,
        flag: "<mode>",
        subcommand: ["dictionary", "expansion"],
    });

    if (!picked) {
        return;
    }

    try {
        await new MeetingsConfigStore().setAbbrExpansion(scopeOf(opts.project), picked);
        ui.ok(
            `Abbreviations in the ${opts.project ? `project ${opts.project}` : "global"} dictionary expand: ${picked}.`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

async function suggest(opts: {
    project?: string;
    source?: string;
    apply?: string | boolean;
    json?: boolean;
}): Promise<void> {
    const sourceId = opts.source ?? "wisprflow";

    if (!isMeetingSourceId(sourceId)) {
        fail(`Unknown source ${sourceId}. Known: ${MEETING_SOURCE_IDS.join(", ")}`);
        return;
    }

    const store = new MeetingsConfigStore();

    try {
        const config = await store.read();
        const suggestions = suggestDictionary({
            dictionary: resolveDictionary(config, { project: opts.project }),
            sourceId,
            sourceWords: await (await meetingSource(sourceId)).dictionary(),
            ignore: config.sources[sourceId].suggest.ignore,
            corrections: readCorrections(),
            project: opts.project,
        });

        if (opts.apply !== undefined) {
            const picks =
                opts.apply === true || opts.apply === "all"
                    ? suggestions.map((_, index) => index + 1)
                    : String(opts.apply).split(",").map(Number);
            const bad = picks.filter((pick) => !Number.isInteger(pick) || pick < 1 || pick > suggestions.length);

            if (bad.length > 0) {
                fail(
                    `--apply takes numbers from 1 to ${suggestions.length} (comma separated) or all; got ${bad.join(", ")}`
                );
                return;
            }

            const entries = picks.map((pick) => suggestions[pick - 1]!.entry);

            if (opts.project && (await store.addProject(opts.project))) {
                ui.ok(`Added project ${opts.project} to the known projects.`);
            }

            await store.putDictionaryEntries(scopeOf(opts.project), entries);
            ui.ok(
                `Saved ${entries.length} entries to the ${opts.project ? `project ${opts.project}` : "global"} dictionary.`
            );
            return;
        }

        if (opts.json) {
            out.result(SafeJSON.stringify(suggestions, null, 2));
            return;
        }

        if (suggestions.length === 0) {
            ui.info("Nothing to suggest: every source word is in the dictionary, ignored, or an ordinary word.");
            return;
        }

        const table = createBoxTable(["#", "TYPE", "VALUE", "SUBSTITUTION", "FROM"]);

        suggestions.forEach((suggestion, index) => {
            const entry = suggestion.entry;
            table.push([
                String(index + 1),
                entry.type,
                pc.white(entry.value),
                "substitution" in entry ? entry.substitution : "—",
                suggestion.from,
            ]);
        });

        out.println(table.toString());
        ui.dim(
            `Save some: ${toolCommand("meetings", "dictionary", "suggest")}${opts.project ? ` --project ${opts.project}` : ""} --apply 1,3 (or --apply all)`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

async function test(phrase: string, opts: { project?: string; json?: boolean }): Promise<void> {
    try {
        const result = testPhrase(await new MeetingsConfigStore().read(), {
            phrase,
            ...(opts.project ? { project: opts.project } : {}),
        });

        if (opts.json) {
            out.result(SafeJSON.stringify(result, null, 2));
            return;
        }

        out.println(result.text);

        for (const entry of result.fired) {
            ui.dim(`  ${entry.type} ${entry.value}${"substitution" in entry ? ` → ${entry.substitution}` : ""}`);
        }

        for (const suggestion of result.suggestions) {
            ui.dim(`  close to ${suggestion.value}: "${suggestion.heard}" (${suggestion.score})`);
        }
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerDictionaryCommand(program: Command): void {
    const dictionary = program
        .command("dictionary")
        .description("Words a transcript gets wrong, abbreviations to expand, terms to know: global and per project");

    dictionary
        .command("show")
        .description("The merged dictionary (global, then the project)")
        .option("--project <name>", "include this project's entries")
        .option("--json", "print JSON")
        .action(show);

    dictionary
        .command("add")
        .argument("<value>", "the word as heard (fix), the abbreviation (abbr), or the term")
        .argument(
            "[substitution]",
            'fix: the right spelling; abbr: the expansion, which must contain the value ("MOP (…)")'
        )
        .description("Add or replace an entry")
        .option("--type [type]", ENTRY_TYPES.join(" | "))
        .option(
            "--project <name>",
            "the project's dictionary instead of the global one (a new name is added to the known projects)"
        )
        .option("--spoken <form>", "term: how people say it (repeatable)", collect)
        .option("--meaning <text>", "term: what it means, shown after its first mention in Markdown")
        .option("--case-sensitive", "fix: match only the exact letter case (default: any case)")
        .action(add);

    dictionary
        .command("suggest")
        .description("Entries proposed from a source's own dictionary and from corrections confirmed twice")
        .option("--project <name>", "compare with and save to this project's dictionary")
        .option("--source <id>", "the source whose dictionary to read (default wisprflow)")
        .option("--apply [numbers]", "save the numbered suggestions (1,3,5) or all")
        .option("--json", "print JSON")
        .action(suggest);

    dictionary
        .command("expansion")
        .argument("[mode]", `${ABBR_EXPANSIONS.join(" | ")}: at every mention, the first, or never`)
        .description("How abbreviations expand, globally or for one project (a meeting can override it)")
        .option("--project <name>", "set it for this project only")
        .action(expansion);

    dictionary
        .command("remove")
        .alias("rm")
        .argument("<value>", "the entry's value")
        .description("Remove an entry")
        .option("--project <name>", "the project's dictionary instead of the global one")
        .action(remove);

    dictionary
        .command("test")
        .argument("<phrase>", "a sentence as a transcript would have it")
        .description("The phrase after the dictionary, with each entry that fired; reads only")
        .option("--project <name>", "the global dictionary and this project's")
        .option("--json", "print JSON")
        .action(test);
}
