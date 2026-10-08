import { out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { Command } from "commander";
import pc from "picocolors";
import { formatQaEntry } from "../lib/format";
import { openReadModel, type QueryOpts, queryEntries } from "../lib/read-model";

export function defaultDbPath(): string {
    return toolDataDir("question", "qa.db");
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
        .description("Show recorded Q→A (oldest first; last N entries)")
        .option("-p, --project <name>", "filter by project")
        .option("-t, --tag <tag>", "filter by tag")
        .option("--session <id>", "filter by originating session")
        .option("--unread", "only unread")
        .option("-l, --limit <n>", "limit", (v) => Number.parseInt(v, 10))
        .option("--format <fmt>", "ai|json", "ai")
        .action(
            async (o: {
                project?: string;
                session?: string;
                tag?: string;
                unread?: boolean;
                limit?: number;
                format?: string;
            }) => {
                const query = { ...o, sessionId: o.session };
                const dbPath = defaultDbPath();
                if (o.format === "json") {
                    const db = openReadModel(dbPath);
                    try {
                        out.result(queryEntries(db, query));
                    } finally {
                        db.close();
                    }

                    await out.flush();
                    process.exit(0);
                }

                out.println(renderDigest({ ...query, dbPath }));
                await out.flush();
                process.exit(0);
            }
        );
}
