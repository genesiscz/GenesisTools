import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { getLocalNote, listLocalNotes, localAvailable } from "../lib/local";
import { getMcpNote, listMcpNotes } from "../lib/mcp";
import { localTime } from "../lib/render";
import type { ScratchpadNote, SourceName } from "../lib/types";
import { errorText, fail, parseSource, reportSource, resolveEnum, TOOL } from "./shared";

const FORMATS = ["table", "json"] as const;
const SHOW_FORMATS = ["md", "json"] as const;

async function list(query: string | undefined, opts: Record<string, unknown>): Promise<void> {
    const source = parseSource(opts.source, ["notes", "list"]);
    const format = await resolveEnum({
        value: opts.format,
        fallback: "table",
        values: FORMATS,
        flag: "--format",
        subcommand: ["notes", "list"],
    });

    if (!source || !format) {
        return;
    }

    const useLocal = source === "local" || (source === "auto" && localAvailable());
    const limit = Number(opts.limit ?? 25);
    let rows: ScratchpadNote[];

    try {
        rows = useLocal ? listLocalNotes(query, limit) : await listMcpNotes(query, limit);
    } catch (err) {
        fail(errorText(err));
        return;
    }

    const used: SourceName = useLocal ? "local" : "mcp";
    reportSource(used);

    if (format === "json") {
        out.result(SafeJSON.stringify({ source: used, notes: rows }, null, 2));
        return;
    }

    const table = createBoxTable(["MODIFIED", "TITLE", "ID", "EXCERPT"]);

    for (const row of rows) {
        table.push([
            localTime(row.modifiedAt),
            pc.white(truncateDisplay(row.title || "(untitled)", 32)),
            pc.dim(row.id),
            truncateDisplay((row.excerpt ?? "").replace(/\s+/g, " "), 48),
        ]);
    }

    out.println(table.toString());
    ui.dim(`${rows.length} note(s) · Next: ${TOOL} notes show <id>`);
}

async function show(id: string, opts: Record<string, unknown>): Promise<void> {
    const source = parseSource(opts.source, ["notes", "show"]);
    const format = await resolveEnum({
        value: opts.format,
        fallback: "md",
        values: SHOW_FORMATS,
        flag: "--format",
        subcommand: ["notes", "show"],
    });

    if (!source || !format) {
        return;
    }

    try {
        const local = source !== "mcp" && localAvailable() ? getLocalNote(id) : undefined;

        if (!local && source === "local") {
            fail(`note ${id} is not in the local Wispr Flow database`);
            return;
        }

        const note = local ?? (await getMcpNote(id));
        const used: SourceName = local ? "local" : "mcp";
        reportSource(used);

        if (format === "json") {
            out.result(SafeJSON.stringify({ source: used, note }, null, 2));
            return;
        }

        out.print(`# ${note.title || "Untitled note"}\n\n${(note.content ?? "").trim()}\n`);
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerNotesCommand(program: Command): void {
    const notes = program.command("notes").description("Wispr Flow scratchpad notes");

    notes
        .command("list")
        .alias("ls")
        .argument("[query]", "text in the title or content")
        .description("List or search notes, newest first")
        .option("--limit <n>", "how many", "25")
        .option("--source [source]", "auto | local | mcp")
        .option("--format [format]", "table | json")
        .action(list);

    notes
        .command("show")
        .argument("<id>", "note id")
        .description("One note's text")
        .option("--source [source]", "auto | local | mcp")
        .option("--format [format]", "md | json")
        .action(show);
}
