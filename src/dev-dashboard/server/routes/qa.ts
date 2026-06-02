import { getConfig } from "@app/dev-dashboard/config";
import { saveToObsidianUnique } from "@app/dev-dashboard/lib/obsidian-save";
import { formatQaAsMarkdown } from "@app/dev-dashboard/lib/qa-clipboard";
import { enrichQaEntry } from "@app/dev-dashboard/lib/qa-render";
import { createQaStream, todayLogFile } from "@app/dev-dashboard/lib/qa-sse";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { defaultDbPath } from "@app/question/commands/log";
import {
    getEntryById,
    markEntriesRead,
    markEntriesUnread,
    openReadModel,
    queryEntries,
} from "@app/question/lib/read-model";
import { getAudioLibrary } from "@app/utils/audio/library";
import { resolveSoundBuffer } from "@app/utils/audio/runner.server";
import { SafeJSON } from "@app/utils/json";

export function qaRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/qa/log",
            handler: (ctx) => {
                let db: ReturnType<typeof openReadModel> | undefined;

                try {
                    db = openReadModel(defaultDbPath());
                    const rows = queryEntries(db, {
                        project: ctx.query.get("project") ?? undefined,
                        tag: ctx.query.get("tag") ?? undefined,
                        unread: ctx.query.get("unread") === "1",
                        limit: Number.parseInt(ctx.query.get("limit") ?? "100", 10),
                    });

                    return { kind: "json", status: 200, body: { entries: rows.map((row) => enrichQaEntry(row)) } };
                } catch (err) {
                    return errorResult(err);
                } finally {
                    db?.close(); // bun:sqlite has no GC finalizer — close every request or leak an FD (t1)
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/qa/read",
            handler: async (ctx) => {
                let db: ReturnType<typeof openReadModel> | undefined;

                try {
                    const body = await ctx.readJson<{ ids?: string[]; unread?: boolean }>();
                    const ids = body.ids?.filter((id) => typeof id === "string" && id.length > 0) ?? [];
                    db = openReadModel(defaultDbPath());
                    const updated = body.unread ? markEntriesUnread(db, ids) : markEntriesRead(db, ids);

                    return { kind: "json", status: 200, body: { ok: true, updated } };
                } catch (err) {
                    return errorResult(err);
                } finally {
                    db?.close();
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/qa/audio-library",
            handler: () => ({ kind: "json", status: 200, body: getAudioLibrary() }),
        },
        {
            method: "GET",
            pattern: "/api/qa/sound",
            handler: (ctx) => {
                try {
                    const id = ctx.query.get("id") ?? "";
                    const lib = getAudioLibrary();
                    const entry = [...lib.bundled, ...lib.synth].find((e) => e.id === id);

                    if (!entry) {
                        return { kind: "json", status: 404, body: { error: `unknown sound id: ${id}` } };
                    }

                    return {
                        kind: "binary",
                        status: 200,
                        contentType: "audio/wav",
                        body: resolveSoundBuffer(entry.choice),
                        headers: { "Cache-Control": "public, max-age=3600" },
                    };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/qa/config",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ sound?: string; soundVolume?: number }>();
                    const args = ["question", "config"];

                    if (body.sound) {
                        args.push("--sound", body.sound);
                    }

                    if (typeof body.soundVolume === "number") {
                        args.push("--sound-volume", String(body.soundVolume));
                    }

                    const proc = Bun.spawn(["tools", ...args], { stdout: "pipe", stderr: "pipe" });
                    const code = await proc.exited;

                    return {
                        kind: "json",
                        status: code === 0 ? 200 : 500,
                        body: { ok: code === 0, output: await new Response(proc.stdout).text() },
                    };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/qa/stream",
            longLived: true,
            handler: () => ({
                kind: "sse",
                start: (emit) => {
                    emit.comment(" qa stream open");
                    const stream = createQaStream(todayLogFile(), (entry) =>
                        emit.data(SafeJSON.stringify(enrichQaEntry(entry)))
                    );
                    const keepAlive = setInterval(() => emit.comment(" ping"), 12_000);

                    return {
                        close: () => {
                            clearInterval(keepAlive);
                            stream.close();
                        },
                    };
                },
            }),
        },
        {
            method: "POST",
            pattern: "/api/qa/save-to-obsidian",
            handler: async (ctx) => {
                let db: ReturnType<typeof openReadModel> | undefined;

                try {
                    const body = await ctx.readJson<{
                        entryId?: string;
                        relativeDir?: string;
                        baseName?: string;
                        mode?: "create" | "append";
                        createDir?: boolean;
                        includeFrontmatter?: boolean;
                        includeQuestion?: boolean;
                    }>();
                    const entryId = body.entryId ?? "";
                    const relativeDir = body.relativeDir ?? "";
                    const baseName = (body.baseName ?? "").replace(/\.md$/i, "").trim();

                    if (!entryId || !relativeDir || !baseName) {
                        return {
                            kind: "json",
                            status: 400,
                            body: { error: "entryId, relativeDir, and baseName required" },
                        };
                    }

                    db = openReadModel(defaultDbPath());
                    const row = getEntryById(db, entryId);

                    if (!row) {
                        return { kind: "json", status: 404, body: { error: `unknown entry: ${entryId}` } };
                    }

                    const enriched = enrichQaEntry(row);
                    const content = formatQaAsMarkdown(
                        { ...row, ...enriched, supersededBy: row.supersededBy, readAt: row.readAt },
                        {
                            includeFrontmatter: body.includeFrontmatter !== false,
                            includeQuestion: body.includeQuestion !== false,
                        }
                    );
                    const { obsidianVault } = await getConfig();

                    if (!obsidianVault) {
                        return { kind: "json", status: 500, body: { error: "obsidian vault not configured" } };
                    }

                    const result = await saveToObsidianUnique({
                        vaultRoot: obsidianVault,
                        relativeDir,
                        baseName,
                        content,
                        mode: body.mode === "append" ? "append" : "create",
                        createDir: body.createDir === true,
                    });

                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return errorResult(err);
                } finally {
                    db?.close();
                }
            },
        },
    ];
}
