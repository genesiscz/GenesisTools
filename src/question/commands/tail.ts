import { FileTailer } from "@app/utils/fs/file-tailer";
import type { Command } from "commander";
import { logFilePathFor } from "../lib/log-store";
import type { QaEntry } from "../lib/types";

function watchToday(): void {
    const file = logFilePathFor({ ts: Date.now() });
    process.stdout.write(`tailing ${file} (Ctrl-C to stop)\n`);
    const t = new FileTailer<QaEntry>(file, {
        onLine: (e) => {
            const when = new Date(e.ts).toISOString().slice(11, 16);
            const preview = e.answerMd.split("\n").slice(0, 3).join("\n");
            process.stdout.write(
                `\n${when} ${e.project} · ${e.branch ?? "-"} [${e.tag}]\n❯ ${e.question}\n${preview}\n`
            );
        },
    });
    t.start();
    process.on("SIGINT", () => {
        t.stop();
        process.exit(0);
    });
}

export function registerTailCommand(program: Command): void {
    program.command("tail").alias("answers").description("Live feed of Q→A as they are recorded").action(watchToday);
}
