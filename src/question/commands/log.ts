import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { openReadModel, type QueryOpts, queryEntries } from "../lib/read-model";

export function defaultDbPath(): string {
    return join(homedir(), ".genesis-tools", "question", "qa.db");
}

export function renderDigest(opts: QueryOpts & { dbPath: string }): string {
    const db = openReadModel(opts.dbPath);
    try {
        const rows = queryEntries(db, opts);
        if (rows.length === 0) {
            return "No questions recorded.";
        }

        return rows
            .map((r) => {
                const when = new Date(r.ts).toISOString().slice(0, 16).replace("T", " ");
                const head = `${when}  ${r.project} · ${r.branch ?? "-"}  [${r.tag}]`;
                const preview = r.answerMd.split("\n").slice(0, 3).join("\n");
                return `${head}\n❯ ${r.question}\n${preview}\n`;
            })
            .join("\n");
    } finally {
        db.close();
    }
}

export function registerLogCommand(program: Command): void {
    program
        .command("log")
        .description("Show recorded Q→A (newest first)")
        .option("-p, --project <name>", "filter by project")
        .option("-t, --tag <tag>", "filter by tag")
        .option("--unread", "only unread")
        .option("-l, --limit <n>", "limit", (v) => Number.parseInt(v, 10))
        .option("--format <fmt>", "ai|json", "ai")
        .action((o: { project?: string; tag?: string; unread?: boolean; limit?: number; format?: string }) => {
            const dbPath = defaultDbPath();
            if (o.format === "json") {
                const db = openReadModel(dbPath);
                try {
                    process.stdout.write(`${SafeJSON.stringify(queryEntries(db, o), null, 2)}\n`);
                } finally {
                    db.close();
                }

                process.exit(0);
            }

            process.stdout.write(`${renderDigest({ ...o, dbPath })}\n`);
            process.exit(0);
        });
}
