import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import pc from "picocolors";
import type { Command } from "commander";
import { formatQaEntry } from "../lib/format";
import { openReadModel, type QueryOpts, queryEntries } from "../lib/read-model";

export function defaultDbPath(): string {
    return join(homedir(), ".genesis-tools", "question", "qa.db");
}

export function renderDigest(opts: QueryOpts & { dbPath: string }): string {
    const db = openReadModel(opts.dbPath);
    try {
        const rows = queryEntries(db, opts);
        if (rows.length === 0) {
            return pc.dim("No questions recorded.");
        }

        return rows.map(formatQaEntry).join("\n");
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
