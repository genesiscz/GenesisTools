import { ingestIndexedDb } from "@app/ms-teams/lib/ingest";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerSyncCommand(program: Command): void {
    program
        .command("sync")
        .description("Snapshot the local Teams IndexedDB cache and ingest it")
        .option("--force", "Rebuild the SQLite cache even if a snapshot exists")
        .action(async (opts: { force?: boolean }) => {
            const result = await ingestIndexedDb({ force: Boolean(opts.force) });
            out.println(
                `Ingested ${result.conversations} conversations, ${result.messages} messages, ${result.people} people.`
            );
        });
}
