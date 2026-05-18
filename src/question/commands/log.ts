import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import type { Command } from "commander";
import { openReadModel, type QueryOpts, queryEntries } from "../lib/read-model";

// chalk auto-detects stdout: full color on a TTY, no-ops when piped/redirected,
// so the digest is colorful in a terminal and clean ANSI-free for `| tools json` etc.
const TAG_TINT: Record<string, (s: string) => string> = {
    question: chalk.bold.blue,
    action: chalk.bold.yellow,
    directive: chalk.bold.green,
};

export function defaultDbPath(): string {
    return join(homedir(), ".genesis-tools", "question", "qa.db");
}

export function renderDigest(opts: QueryOpts & { dbPath: string }): string {
    const db = openReadModel(opts.dbPath);
    try {
        const rows = queryEntries(db, opts);
        if (rows.length === 0) {
            return chalk.dim("No questions recorded.");
        }

        return rows
            .map((r) => {
                const when = new Date(r.ts).toISOString().slice(0, 16).replace("T", " ");
                const tint = TAG_TINT[r.tag] ?? chalk.bold.gray;
                const head = `${chalk.dim(when)}  ${chalk.cyan.bold(r.project)} ${chalk.dim("·")} ${chalk.magenta(r.branch ?? "-")}  ${tint(`[${r.tag}]`)}`;
                const preview = chalk.yellow(r.answerMd.split("\n").slice(0, 3).join("\n"));
                return `${head}\n${chalk.green("❯")} ${chalk.bold(r.question)}\n${preview}\n`;
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
