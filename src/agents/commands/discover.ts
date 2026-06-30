import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import type { Command } from "commander";
import { readCursor } from "../lib/cursor";
import { deriveRegistry } from "../lib/derived-registry";
import { runWithFriendlyErrors } from "../lib/errors";
import { readFeed } from "../lib/feed";
import { ensureSessionDir, sessionPaths } from "../lib/paths";
import { resolveSession } from "../lib/session-resolve";
import { runStaleSweep } from "../lib/slot-lock";

interface DiscoverOpts {
    session?: string;
    format?: "json" | "table";
}

async function runDiscoverImpl(opts: DiscoverOpts): Promise<void> {
    const resolved = resolveSession(opts.session);
    const paths = sessionPaths(resolved.session);
    ensureSessionDir(paths);
    await runStaleSweep(paths);

    const events = await readFeed(paths);
    const records = deriveRegistry(events);
    const format = opts.format ?? (process.stdout.isTTY ? "table" : "json");

    if (format === "json") {
        out.result(SafeJSON.stringify(records, { strict: true }));
        return;
    }

    if (records.length === 0) {
        out.println(chalk.dim(`(no agents registered in session "${paths.session}")`));
        return;
    }

    const rows: string[][] = [["AGENT_ID", "NAME", "STATUS", "MAIN", "ROLE", "LAST_SEQ"]];

    for (const r of records) {
        let status = "registered";

        if (r.logged_in_at) {
            status = r.logged_out_at ? "logged_out" : "logged_in";
        }

        rows.push([
            r.agent_id || "(awaiting login)",
            r.agent_name,
            status,
            r.is_main ? "yes" : "",
            r.role ?? "",
            String(readCursor(paths, r.agent_id)),
        ]);
    }

    const colWidths = rows[0]?.map((_, idx) => Math.max(...rows.map((row) => (row[idx] ?? "").length))) ?? [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        if (!row) {
            continue;
        }

        const line = row.map((cell, idx) => cell.padEnd(colWidths[idx] ?? 0)).join("  ");

        if (i === 0) {
            out.println(chalk.bold(line));
        } else {
            out.println(line);
        }
    }
}

export async function runDiscover(opts: DiscoverOpts): Promise<void> {
    await runWithFriendlyErrors(() => runDiscoverImpl(opts));
}

export function registerDiscoverCommand(program: Command): void {
    program
        .command("discover")
        .description("List all registered agents in the session")
        .option("--session <id>", "Override session resolution")
        .option("--format <fmt>", "Output format: json or table (default: table on TTY, json otherwise)")
        .action(async (opts: DiscoverOpts) => {
            await runDiscover(opts);
        });
}
