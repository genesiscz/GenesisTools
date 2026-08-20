import { openCache } from "@app/ms-teams/lib/cache";
import { parseShowQuery } from "@app/ms-teams/lib/query";
import { resolveConversation } from "@app/ms-teams/lib/resolve-chat";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerTranscriptsCommand(program: Command): void {
    program
        .command("transcripts [query...]")
        .description("Print cached call-transcript messages for a meeting or chat")
        .option("--id <threadId>", "Exact conversation id")
        .option("--json", "Machine-readable JSON")
        .action((queryParts: string[], opts: { id?: string; json?: boolean }) => {
            const cache = openCache();

            try {
                const resolved = resolveConversation(cache, {
                    ...parseShowQuery((queryParts ?? []).join(" ")),
                    id: opts.id,
                });

                if (resolved.status !== "exact") {
                    out.println("Could not resolve a single conversation. Pass --id.");
                    return;
                }

                const rows = cache
                    .listMessages(resolved.conversation.id, { includeSystem: true })
                    .filter((m) => m.messageType.includes("CallTranscript") || m.messageType.includes("CallRecording"));

                if (opts.json) {
                    out.result(rows);
                    return;
                }

                if (rows.length === 0) {
                    out.println("No cached transcripts or recordings in that thread.");
                    return;
                }

                for (const row of rows) {
                    out.println(`--- ${row.messageType} ${row.id} ---`);
                    out.println(row.text || row.html || "(empty)");
                    out.println("");
                }
            } finally {
                cache.close();
            }
        });
}
