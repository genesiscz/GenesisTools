import { formatBytes } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";
import { getDbInfo, listMigrations, vacuumDb } from "@app/shops/lib/db-admin";

export function registerDbCommand(program: Command): void {
    const db = program.command("db").description("Database administration");

    db.command("migrate")
        .description("Run pending migrations (auto-runs on every open)")
        .action(async () => {
            const rows = listMigrations();
            const out = formatTable(
                rows.map((r) => [r.id, new Date(r.applied_at).toISOString(), `${r.ms}ms`]),
                ["migration_id", "applied_at", "duration"]
            );
            process.stdout.write(`${out}\n`);
        });

    db.command("info")
        .description("Show DB path, size, and per-table row counts")
        .action(async () => {
            const info = getDbInfo();
            const size = info.sizeBytes !== null ? formatBytes(info.sizeBytes) : "(unknown)";

            process.stdout.write(`db path: ${info.path}\n`);
            process.stdout.write(`db size: ${size}\n\n`);
            process.stdout.write(
                `${formatTable(
                    info.tables.map((t) => [t.name, String(t.rows)]),
                    ["table", "rows"],
                    { alignRight: [1] }
                )}\n`
            );
        });

    db.command("vacuum")
        .description("Run VACUUM on the shops DB")
        .action(async () => {
            vacuumDb();
            process.stdout.write("VACUUM done.\n");
        });
}
