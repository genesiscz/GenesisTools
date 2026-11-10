import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { localTime } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import pc from "picocolors";
import { actorText, itemIdOf, type JournalReadEntry } from "../lib/decision-journal";
import { questionLabel } from "../lib/questions";
import { withMeetingsClient } from "../lib/service/client";
import { errorText, fail, TOOL } from "../lib/shared";
import { assignmentText } from "../lib/speaker-assign";

/** At most this many items are named on an entry's line; the rest are counted. */
const NAMED_ITEMS = 8;

interface JournalOptions {
    item?: string;
    limit?: string;
    json?: boolean;
}

/** Items as people name them (Q12 for a question), the first few of them, then how many more. */
function named(record: MeetingRecord, ids: string[]): string {
    const shown = ids.slice(0, NAMED_ITEMS).map((id) => {
        const item = record.items.find((one) => one.id === id);
        return item?.kind === "question" ? questionLabel(record, id) : id;
    });
    const more = ids.length - shown.length;
    return `${shown.join(" ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** A meeting field's value in a journal line: a label list joined, an absent value as "none". */
function fieldText(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return value.length > 0 ? value.join(", ") : "none";
    }

    return value ?? "none";
}

/** What an entry did, in a few words: "confirm i1 i2", "Q3 → Alice Example (settled Q4)", "undo of 1b2c3d4e: i1". */
function whatText(record: MeetingRecord, entry: JournalReadEntry): string {
    const { action } = entry;
    const changed = entry.changes.map((change) => change.id);

    switch (action.kind) {
        case "confirm":
        case "reject":
            return `${action.kind} ${named(record, entry.decided)}`;
        case "respell":
            return `respell ${action.item} → ${action.text.trim()}`;
        case "answer": {
            const settled = entry.settled.length > 0 ? ` (settled ${named(record, entry.settled)})` : "";
            return `answer ${named(record, entry.question ? [entry.question] : [])} → ${action.answer.trim()}${settled}`;
        }
        case "skip":
            return `skip ${named(record, entry.question ? [entry.question] : [])}`;
        case "split": {
            const parts = entry.changes.filter((change) => !change.before && change.after?.kind === "question").length;
            return `split ${named(record, entry.question ? [entry.question] : [])} into ${parts} parts`;
        }
        case "rename":
            return `rename ${action.label} → ${action.name.trim()}`;
        case "assign": {
            const stretches = (entry.assignments ?? []).flatMap((change) => (change.after ? [change.after] : []));
            return `assign ${stretches.map(assignmentText).join(", ") || "nothing"} → ${action.person.trim()}`;
        }
        case "reopen":
            return `reopen ${named(record, changed)}`;
        case "revert":
            return `undo of ${action.token.slice(0, 8)}: ${named(record, changed)}`;
        case "add":
            return `add ${named(record, changed)}`;
        case "set":
            return `set ${(entry.fields ?? []).map((field) => `${field.field} ${fieldText(field.after)}`).join(", ")}`;
        case "comment":
            return `told the listening agent: ${action.comments.map((comment) => `"${comment.text.trim()}"`).join(", ")}`;
    }
}

async function journal(ref: string, opts: JournalOptions): Promise<void> {
    const store = new MeetingStore();
    let record: MeetingRecord | undefined;

    try {
        record = store.resolve(ref);
    } catch (err) {
        fail(errorText(err));
        return;
    }

    if (!record) {
        fail(`No meeting "${ref}". List them: ${TOOL} list`);
        return;
    }

    const limit = opts.limit === undefined ? undefined : Number(opts.limit);

    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
        fail(`--limit takes a whole number above 0 (got "${opts.limit}").`);
        return;
    }

    const item = opts.item ? itemIdOf(record, opts.item) : undefined;
    let entries: JournalReadEntry[];

    try {
        ({ entries } = await withMeetingsClient((client) =>
            client.call("journal.read", { meeting: record.id, ...(item ? { item } : {}), ...(limit ? { limit } : {}) })
        ));
    } catch (err) {
        fail(errorText(err));
        return;
    }

    if (opts.json) {
        out.result(SafeJSON.stringify({ meeting: record.id, entries }, null, 2));
        return;
    }

    if (entries.length === 0) {
        ui.info(
            item
                ? `No decision in ${record.id} changed ${opts.item}.`
                : `No decision in ${record.id} yet. Decide one: ${TOOL} confirm ${record.id} <ids>`
        );
        return;
    }

    for (const entry of entries) {
        const reason = entry.reason ? pc.italic(` "${entry.reason}"`) : "";
        const undone = entry.revertedBy ? pc.yellow(` · undone by ${entry.revertedBy.slice(0, 8)}`) : "";
        out.println(
            `${pc.dim(localTime(entry.at))}  ${whatText(record, entry)}  ${pc.dim("by")} ${actorText(entry.actor)}${reason}`
        );
        out.println(pc.dim(`    token ${entry.token}${undone}`));
    }

    ui.dim(`Undo one: ${TOOL} reopen ${record.id} <items> --token <token>`);
}

export function registerJournalCommand(program: Command): void {
    program
        .command("journal")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description("Who decided what in the meeting, when and why: its decision journal, newest first")
        .option("--item <i42|Q12>", "only the entries that changed this item")
        .option("--limit <n>", "at most this many entries")
        .option("--json", "print { meeting, entries } as JSON, each entry with its items before and after")
        .action(journal);
}
