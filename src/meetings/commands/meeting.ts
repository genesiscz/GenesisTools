import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isInteractive } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore, mergeLabels } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore, nextId } from "@genesiscz/utils/meetings/record";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { localTime } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import pc from "picocolors";
import { collectAndReport } from "../lib/collect";
import { linkSource } from "../lib/link";
import { resolveProject } from "../lib/project";
import { errorText, fail, TOOL } from "../lib/shared";
import { showText } from "../lib/show-text";
import { windowJson } from "../lib/window-reads";
import { askProjectAtEnd } from "./watch";

/** The record a command names, or a message saying how to find one. */
function requireMeeting(store: MeetingStore, ref: string): MeetingRecord | undefined {
    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
        }

        return record;
    } catch (err) {
        fail(errorText(err));
        return undefined;
    }
}

async function create(
    title: string | undefined,
    opts: { at?: string; project?: string; source?: string; yes?: boolean }
): Promise<void> {
    const store = new MeetingStore();
    const config = new MeetingsConfigStore();

    try {
        if (opts.source) {
            const { record, created } = await linkSource({
                store,
                config,
                sourceRef: opts.source,
                project: opts.project,
                command: "new",
                createdBy: "new",
                quiet: opts.yes,
            });
            ui.ok(
                `${created ? "Created" : "Already there:"} ${record.id}${record.project ? ` (project ${record.project})` : ""}`
            );
            await collectAndReport(store, record);

            if (record.end) {
                await askProjectAtEnd(store, record.id);
            }

            return;
        }

        let name = title;

        if (!name && isInteractive()) {
            const typed = await p.text({ message: "Meeting title" });
            name = p.isCancel(typed) ? undefined : typed;
        }

        if (!name) {
            fail(`A title is needed: ${TOOL} new "<title>" (or --source wisprflow:<id>)`);
            return;
        }

        const start = opts.at ? new Date(opts.at) : new Date();

        if (Number.isNaN(start.getTime())) {
            fail(`--at ${opts.at} is not a time (try 2026-11-02T15:00).`);
            return;
        }

        const { project } = await resolveProject({
            config,
            flag: opts.project,
            facts: { title: name },
            quiet: opts.yes,
        });
        const record = await store.create(
            { title: name, start: start.toISOString(), createdBy: "new", ...(project ? { project } : {}) },
            { command: "new", change: `created "${name}"` }
        );
        ui.ok(`Created ${record.id}${project ? ` (project ${project})` : ""}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function list(opts: { project?: string; json?: boolean }): Promise<void> {
    const records = new MeetingStore().list().filter((record) => !opts.project || record.project === opts.project);

    if (opts.json) {
        out.result(SafeJSON.stringify(records, null, 2));
        return;
    }

    if (records.length === 0) {
        const hint = new MeetingStore().layoutHint();

        if (hint) {
            ui.warn(hint);
            return;
        }

        ui.info(`No meetings yet. Create one: ${TOOL} new "<title>" or ${TOOL} new --source wisprflow:<id>`);
        return;
    }

    const table = createBoxTable(["WHEN", "ID", "PROJECT", "SOURCES", "CONTEXT", "ITEMS"]);

    for (const record of records) {
        const open = record.items.filter((item) => item.status === "suggested").length;
        table.push([
            localTime(record.start),
            pc.white(record.id),
            record.project ?? pc.yellow("none"),
            Object.keys(record.sources).join(", ") || "—",
            String(record.context.length),
            record.items.length === 0 ? "—" : `${record.items.length} (${open} open)`,
        ]);
    }

    out.println(table.toString());
}

async function show(ref: string, opts: { json?: boolean }): Promise<void> {
    const record = requireMeeting(new MeetingStore(), ref);

    if (!record) {
        return;
    }

    if (opts.json) {
        out.result(windowJson(record));
        return;
    }

    out.print(showText(record));
}

async function set(
    ref: string,
    opts: { project?: string; title?: string; label?: string[]; unlabel?: string[] }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    const labels = opts.label ?? [];
    const unlabel = opts.unlabel ?? [];

    if (!opts.project && !opts.title && labels.length === 0 && unlabel.length === 0) {
        fail("Nothing to set: give --project <name>, --title <text>, --label <text> or --unlabel <text>.");
        return;
    }

    try {
        const config = new MeetingsConfigStore();
        const project = opts.project ? (await resolveProject({ config, flag: opts.project })).project : undefined;
        const target = project ?? record.project;

        if (target && labels.length > 0) {
            await config.setProjectLabels(target, { add: labels });
        }

        const changes = [
            project ? `project ${project}` : "",
            opts.title ? `title "${opts.title}"` : "",
            labels.length > 0 ? `labels + ${labels.join(", ")}` : "",
            unlabel.length > 0 ? `labels - ${unlabel.join(", ")}` : "",
        ].filter(Boolean);
        const removed = new Set(unlabel.map((label) => label.toLowerCase()));
        const updated = await store.update(record.id, { command: "set", change: changes.join(", ") }, (current) => {
            current.project = project ?? current.project;
            current.title = opts.title ?? current.title;
            current.labels = mergeLabels(current.labels, labels).filter((label) => !removed.has(label.toLowerCase()));
        });
        ui.ok(
            `${record.id}: ${changes.join(", ")}${updated.labels.length > 0 ? ` (labels: ${updated.labels.join(", ")})` : ""}`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

async function link(ref: string, sourceRef: string, opts: { project?: string }): Promise<void> {
    try {
        const store = new MeetingStore();
        const { record } = await linkSource({
            store,
            config: new MeetingsConfigStore(),
            sourceRef,
            meetingRef: ref,
            project: opts.project,
            command: "link",
            createdBy: "link",
        });
        ui.ok(`${record.id}: linked ${sourceRef}`);
        await collectAndReport(store, record);

        if (record.end) {
            await askProjectAtEnd(store, record.id);
        }
    } catch (err) {
        fail(errorText(err));
    }
}

async function contextAdd(
    ref: string,
    target: string | undefined,
    opts: { title?: string; note?: string }
): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    let kind: "file" | "url" | "note";
    let value: string;

    if (target && /^https?:\/\//.test(target)) {
        kind = "url";
        value = target;
    } else if (target) {
        value = resolve(target);
        kind = "file";

        if (!existsSync(value)) {
            fail(`No such file: ${value}. A context file is referenced by its path, so it must exist.`);
            return;
        }
    } else if (opts.note) {
        kind = "note";
        value = opts.note;
    } else {
        fail(`Give a file, a URL, or --note "<text>".`);
        return;
    }

    try {
        const updated = await store.update(
            record.id,
            { command: "context add", change: `${kind} ${value}` },
            (current) => {
                current.context.push({
                    id: nextId("c", current.context),
                    kind,
                    ref: value,
                    ...(opts.title ? { title: opts.title } : {}),
                    ...(opts.note && kind !== "note" ? { note: opts.note } : {}),
                    addedAt: new Date().toISOString(),
                    addedBy: "user",
                });
            }
        );
        ui.ok(`${updated.context.at(-1)!.id} added to ${record.id}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function contextList(ref: string, opts: { json?: boolean }): Promise<void> {
    const record = requireMeeting(new MeetingStore(), ref);

    if (!record) {
        return;
    }

    if (opts.json) {
        out.result(SafeJSON.stringify(record.context, null, 2));
        return;
    }

    const table = createBoxTable(["ID", "KIND", "REF", "TITLE / NOTE"]);

    for (const entry of record.context) {
        table.push([
            entry.id,
            entry.kind,
            truncateDisplay(entry.ref, 70),
            truncateDisplay([entry.title, entry.note].filter(Boolean).join(": "), 50),
        ]);
    }

    out.println(table.toString());
}

async function contextRemove(ref: string, id: string): Promise<void> {
    const store = new MeetingStore();
    const record = requireMeeting(store, ref);

    if (!record) {
        return;
    }

    if (!record.context.some((entry) => entry.id === id)) {
        fail(`${record.id} has no context ${id} (${TOOL} context list ${record.id}).`);
        return;
    }

    try {
        await store.update(record.id, { command: "context remove", change: id }, (current) => {
            current.context = current.context.filter((entry) => entry.id !== id);
        });
        ui.ok(`Removed ${id} from ${record.id}`);
    } catch (err) {
        fail(errorText(err));
    }
}

const MEETING_REF = "meeting id, a unique prefix, last, or wisprflow:<id>";

export function registerMeetingCommands(program: Command): void {
    program
        .command("new")
        .argument("[title]", "the meeting's title")
        .description("Create a meeting record, by hand or from a source's meeting")
        .option("--at <time>", "when it started (default: now)")
        .option("--project <name>", "its project (a new name joins the known projects)")
        .option("--source <ref>", "build it from a source's meeting: wisprflow:<id>")
        .option("-y, --yes", "never prompt for a project")
        .action(create);

    program
        .command("list")
        .alias("ls")
        .description("The meeting records, newest first")
        .option("--project <name>", "only this project's")
        .option("--json", "print JSON")
        .action(list);

    program
        .command("show")
        .argument("<meeting>", MEETING_REF)
        .description("One meeting record")
        .option("--json", "print the record")
        .action(show);

    program
        .command("set")
        .argument("<meeting>", MEETING_REF)
        .description("Change a meeting's project, title or labels")
        .option("--project <name>", "its project (a new name joins the known projects)")
        .option("--title <text>", "its title")
        .option("--label <text...>", "add labels (a new one joins the project's known labels)")
        .option("--unlabel <text...>", "remove labels from the meeting")
        .action(set);

    program
        .command("link")
        .argument("<meeting>", MEETING_REF)
        .argument("<source>", "the source's meeting: wisprflow:<id>")
        .description("Attach a source's meeting: its transcript, people, times and calendar entry")
        .option("--project <name>", "its project, when it has none yet")
        .action(link);

    const context = program.command("context").description("Reference material for a meeting: notes, files, links");

    context
        .command("add")
        .argument("<meeting>", MEETING_REF)
        .argument("[file|url]", "a file (kept as its path, never copied) or a URL")
        .description("Add a context reference")
        .option("--title <text>", "a title for it")
        .option("--note <text>", "why it matters; alone, a note of its own")
        .action(contextAdd);

    context
        .command("list")
        .argument("<meeting>", MEETING_REF)
        .description("The meeting's context")
        .option("--json", "print JSON")
        .action(contextList);
    context
        .command("remove")
        .alias("rm")
        .argument("<meeting>", MEETING_REF)
        .argument("<id>", "c1, c2 …")
        .description("Remove a context reference")
        .action(contextRemove);
}
