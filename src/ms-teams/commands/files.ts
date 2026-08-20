import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { downloadAttachments } from "@app/ms-teams/lib/attachments";
import { openCache } from "@app/ms-teams/lib/cache";
import { parseShowQuery } from "@app/ms-teams/lib/query";
import { resolveConversation } from "@app/ms-teams/lib/resolve-chat";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";

export function registerFilesCommand(program: Command): void {
    const files = program.command("files").description("List or download attachments from cached messages");

    files
        .command("ls [query...]")
        .description("List attachments")
        .option("--id <threadId>", "Limit to one conversation")
        .option("--json", "Machine-readable JSON")
        .action((queryParts: string[], opts: { id?: string; json?: boolean }) => {
            const cache = openCache();

            try {
                const conversationId = resolveOptionalId(cache, queryParts, opts.id);
                const rows = cache.listFiles(conversationId);

                if (opts.json) {
                    out.result(rows);
                    return;
                }

                renderCliHeader("Teams files", `${rows.length} attachments`);
                const table = createBoxTable(["CHAT", "NAME", "URL"]);

                for (const row of rows) {
                    table.push([
                        truncateDisplay(cache.getConversation(row.conversationId)?.title ?? row.conversationId, 28),
                        truncateDisplay(row.name, 32),
                        truncateDisplay(row.url ?? "—", 48),
                    ]);
                }

                out.println(table.toString());
            } finally {
                cache.close();
            }
        });

    files
        .command("download [query...]")
        .description("Download attachments for a conversation into --out")
        .requiredOption("--out <dir>", "Directory to write files into")
        .option("--id <threadId>", "Exact conversation id")
        .action(async (queryParts: string[], opts: { out: string; id?: string }) => {
            const cache = openCache();

            try {
                const conversationId = resolveOptionalId(cache, queryParts, opts.id);

                if (!conversationId) {
                    out.println("Pass a conversation query or --id.");
                    return;
                }

                const rows = cache.listFiles(conversationId);
                await mkdir(opts.out, { recursive: true });
                const downloaded = await downloadAttachments({
                    attachments: rows.map((r) => ({
                        name: r.name,
                        mimeHint: null,
                        url: r.url,
                        itemId: null,
                        localPath: null,
                    })),
                    outDir: opts.out,
                });
                out.println(
                    `Saved ${downloaded.attachments.filter((a) => a.localPath).length} files under ${join(opts.out)}`
                );
            } finally {
                cache.close();
            }
        });
}

function resolveOptionalId(
    cache: ReturnType<typeof openCache>,
    queryParts: string[] | undefined,
    id?: string
): string | undefined {
    if (id) {
        return id;
    }

    const text = (queryParts ?? []).join(" ").trim();

    if (!text) {
        return undefined;
    }

    const resolved = resolveConversation(cache, parseShowQuery(text));
    return resolved.status === "exact" ? resolved.conversation.id : undefined;
}
