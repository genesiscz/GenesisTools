import { FileTailer } from "@app/utils/fs/file-tailer";
import pc from "picocolors";
import type { Command } from "commander";
import { formatQaEntry } from "../lib/format";
import { logFilePathFor } from "../lib/log-store";
import { openReadModel, queryEntries } from "../lib/read-model";
import type { QaEntry } from "../lib/types";
import { defaultDbPath } from "./log";

function watchToday(opts: { lines?: number }): void {
    const backlog = opts.lines ?? 10;

    // Backlog: last N entries oldest→newest (chronological, like `tail -f`),
    // rendered identically to `tools question log` via the shared formatter.
    if (backlog > 0) {
        const db = openReadModel(defaultDbPath());
        try {
            const rows = queryEntries(db, { limit: backlog });
            if (rows.length > 0) {
                process.stdout.write(`${[...rows].reverse().map(formatQaEntry).join("\n")}\n`);
            }
        } finally {
            db.close();
        }
    }

    const file = logFilePathFor({ ts: Date.now() });
    process.stdout.write(pc.dim(`\n— live: tailing ${file} (Ctrl-C to stop) —\n`));
    const t = new FileTailer<QaEntry>(file, {
        onLine: (e) => process.stdout.write(`\n${formatQaEntry(e)}`),
    });
    t.start();
    process.on("SIGINT", () => {
        t.stop();
        process.exit(0);
    });
}

export function registerTailCommand(program: Command): void {
    program
        .command("tail")
        .alias("answers")
        .description("Live feed of Q→A as they are recorded (with last-N backlog)")
        .option("-n, --lines <n>", "show the last N entries before tailing (0 = none)", (v) => Number.parseInt(v, 10))
        .action((o: { lines?: number }) => watchToday(o));
}
