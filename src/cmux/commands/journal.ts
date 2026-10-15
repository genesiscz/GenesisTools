import { type CompactJournalResult, compactJournal } from "@app/cmux/lib/journal-compact";
import { ui } from "@genesiscz/utils/cli/ui";
import { CMUX_REFS_MAX_AGE_MS } from "@genesiscz/utils/cmux/session-refs";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface CompactFlags {
    dryRun?: boolean;
    json?: boolean;
}

/** `tools cmux journal compact`: the surface journal without the lines no reader looks at. */
export function registerJournalCommand(parent: Command): void {
    const journal = parent
        .command("journal")
        .description("The surface journal (cmux-refs.jsonl) that places each agent session in its tab");

    journal
        .command("compact")
        .description(
            "Rewrite the journal keeping, per session and tab, the first and last line, every end marker and the last 24 hours; drops lines older than the readers' 7 days. The old file is kept as a .bak next to it"
        )
        .option("--dry-run", "Print the line and byte counts before and after, write nothing")
        .option("--json", "Emit the result as JSON")
        .action((flags: CompactFlags) => {
            const result = compactJournal({ dryRun: Boolean(flags.dryRun) });

            if (flags.json) {
                out.result(result);

                return;
            }

            printCompaction(result);
        });
}

/** Exact counts: the point of the report is to compare two numbers, which `formatNumber` rounds to 19.3K. */
function count(value: number): string {
    return value.toLocaleString("en-US");
}

function size(bytes: number): string {
    return `${count(bytes)} (${formatBytes(bytes)})`;
}

function printCompaction(result: CompactJournalResult): void {
    const days = Math.round(CMUX_REFS_MAX_AGE_MS / (24 * 60 * 60 * 1000));

    ui.header(result.dryRun ? "cmux journal compact (dry run)" : "cmux journal compact");
    ui.kv("file", result.path, 8);

    if (result.linesBefore === 0 && result.bytesBefore === 0) {
        ui.info("The journal does not exist or is empty. Nothing to compact.");

        return;
    }

    ui.kv("lines", `before ${count(result.linesBefore)}, after ${count(result.linesAfter)}`, 8);
    ui.kv("bytes", `before ${size(result.bytesBefore)}, after ${size(result.bytesAfter)}`, 8);
    ui.kv(
        "dropped",
        `${count(result.dropped.redundant)} in the middle of a session, ${count(result.dropped.aged)} older than ${days} days, ${count(result.dropped.unreadable)} unreadable`,
        8
    );

    if (!result.changed) {
        ui.ok("The journal is already compact. Nothing was written.");

        return;
    }

    if (result.dryRun) {
        ui.info("Dry run: nothing was written. Run without --dry-run to compact.");

        return;
    }

    ui.ok(`Compacted. The original is kept at ${result.backupPath}`);

    for (const moved of result.movedBackups) {
        ui.dim(`An older backup was moved aside to ${moved} (/tmp clears at reboot).`);
    }

    if (result.carriedBytes > 0) {
        ui.dim(`${formatBytes(result.carriedBytes)} that agents appended during the rewrite were carried over.`);
    }
}
