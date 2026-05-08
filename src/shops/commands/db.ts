import { statSync } from "node:fs";
import { formatBytes } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";
import { getShopsDatabase } from "../db/ShopsDatabase";

export function registerDbCommand(program: Command): void {
    const db = program.command("db").description("Database administration");

    db.command("migrate")
        .description("Run pending migrations (auto-runs on every open)")
        .action(async () => {
            const shopsDb = getShopsDatabase();
            const rows = shopsDb
                .raw()
                .query<{ id: string; applied_at: number; ms: number }, []>(
                    `SELECT id, applied_at, ms FROM _migrations ORDER BY applied_at`
                )
                .all();
            const out = formatTable(
                rows.map((r) => [r.id, new Date(r.applied_at).toISOString(), `${r.ms}ms`]),
                ["migration_id", "applied_at", "duration"]
            );
            process.stdout.write(`${out}\n`);
        });

    db.command("info")
        .description("Show DB path, size, and per-table row counts")
        .action(async () => {
            const shopsDb = getShopsDatabase();
            const path = shopsDb.path();
            let size = "(unknown)";
            try {
                size = formatBytes(statSync(path).size);
            } catch {
                // file may not exist on first --info
            }

            const tables = shopsDb
                .raw()
                .query<{ name: string }, []>(
                    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'products_fts%' ORDER BY name`
                )
                .all();
            const rows = tables.map((t) => {
                const c = shopsDb.raw().query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${t.name}`).get();
                return [t.name, String(c?.c ?? 0)];
            });

            process.stdout.write(`db path: ${path}\n`);
            process.stdout.write(`db size: ${size}\n\n`);
            process.stdout.write(`${formatTable(rows, ["table", "rows"], { alignRight: [1] })}\n`);
        });

    db.command("vacuum")
        .description("Run VACUUM on the shops DB")
        .action(async () => {
            const shopsDb = getShopsDatabase();
            shopsDb.raw().exec("VACUUM");
            process.stdout.write("VACUUM done.\n");
        });
}
