import { mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { downloadAttachments } from "@app/ms-teams/lib/attachments";
import { openCache } from "@app/ms-teams/lib/cache";
import { printConversations } from "@app/ms-teams/lib/display";
import { renderHtml } from "@app/ms-teams/lib/export/html";
import { renderJson } from "@app/ms-teams/lib/export/json";
import { renderMarkdown } from "@app/ms-teams/lib/export/markdown";
import { exportThread } from "@app/ms-teams/lib/export/thread";
import { mergeShowQuery, parseQueryDate, parseShowQuery } from "@app/ms-teams/lib/query";
import { resolveConversation } from "@app/ms-teams/lib/resolve-chat";
import type { ThreadExport } from "@app/ms-teams/lib/types";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerShowCommand(program: Command): void {
    program
        .command("show [query...]")
        .description("Export one conversation as markdown, JSON, or HTML")
        .option("--id <threadId>", "Exact conversation id")
        .option("--with <name>", "Participant display name")
        .option("--topic <text>", "Topic or title")
        .option("--from <date>", "Include messages after this date")
        .option("--to <date>", "Include messages before this date")
        .option("--format <fmt>", "md | json | html", "md")
        .option("--json", "Alias for --format json on stdout")
        .option("--out <path>", "Write to a file or directory")
        .option("--attachments", "Try to download files next to --out")
        .option("--include-system", "Keep member-join and similar system events in md/html")
        .action(async (queryParts: string[], opts: ShowFlags) => {
            const cache = openCache();

            try {
                const parsed = parseShowQuery((queryParts ?? []).join(" "));
                const query = mergeShowQuery(parsed, {
                    id: opts.id,
                    withName: opts.with,
                    topic: opts.topic,
                    from: opts.from ? parseQueryDate(opts.from, "start") : undefined,
                    to: opts.to ? parseQueryDate(opts.to, "end") : undefined,
                });
                const resolved = resolveConversation(cache, query);

                if (resolved.status === "none") {
                    out.println("No conversation matched that query.");
                    return;
                }

                if (resolved.status === "ambiguous") {
                    out.println("Several conversations matched. Pass --id from this list:");
                    printConversations(resolved.matches);
                    out.println(
                        suggestCommand("tools ms-teams show", { add: ["--id", resolved.matches[0]?.id ?? ""] })
                    );
                    return;
                }

                const format = opts.json ? "json" : (opts.format ?? "md");
                const includeSystem = format === "json" || Boolean(opts.includeSystem);
                let thread = exportThread(cache, resolved.conversation.id, {
                    from: query.from,
                    to: query.to,
                    includeSystem,
                });

                if (opts.attachments && opts.out) {
                    thread = await withDownloads(thread, opts.out);
                }

                const rendered = renderThread(thread, format);

                if (opts.json || format === "json") {
                    if (opts.out) {
                        await writeOut(opts.out, rendered, "json");
                    } else {
                        out.result(thread);
                    }

                    return;
                }

                if (opts.out) {
                    const dest = await writeOut(opts.out, rendered, format === "html" ? "html" : "md");
                    out.println(`Wrote ${dest} (${thread.messages.length} messages).`);
                    return;
                }

                if (format === "html" && !isInteractive()) {
                    out.print(rendered);
                    return;
                }

                out.print(rendered);
            } finally {
                cache.close();
            }
        });
}

interface ShowFlags {
    id?: string;
    with?: string;
    topic?: string;
    from?: string;
    to?: string;
    format?: string;
    json?: boolean;
    out?: string;
    attachments?: boolean;
    includeSystem?: boolean;
}

function renderThread(thread: ThreadExport, format: string): string {
    if (format === "html") {
        return renderHtml(thread);
    }

    if (format === "json") {
        return renderJson(thread);
    }

    return renderMarkdown(thread);
}

async function writeOut(outPath: string, body: string, ext: string): Promise<string> {
    const looksDir = outPath.endsWith("/") || extname(outPath) === "";
    const filePath = looksDir ? join(outPath, `thread.${ext}`) : outPath;
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, body);
    return filePath;
}

async function withDownloads(thread: ThreadExport, outPath: string): Promise<ThreadExport> {
    const dir =
        extname(outPath) === "" || outPath.endsWith("/")
            ? join(outPath, "attachments")
            : join(dirname(outPath), "attachments");
    const messages = [];

    for (const message of thread.messages) {
        if (message.attachments.length === 0) {
            messages.push(message);
            continue;
        }

        const downloaded = await downloadAttachments({ attachments: message.attachments, outDir: dir });
        messages.push({ ...message, attachments: downloaded.attachments });
    }

    return { ...thread, messages };
}
