import { getConfig } from "@app/dev-dashboard/config";
import { createHandoffStream } from "@app/dev-dashboard/lib/handoff-sse";
import { saveToObsidianUnique } from "@app/dev-dashboard/lib/obsidian-save";
import { clipQaEntry } from "@app/dev-dashboard/lib/qa-clip";
import { formatQaAsMarkdown } from "@app/dev-dashboard/lib/qa-clipboard";
import { createPendingStream } from "@app/dev-dashboard/lib/qa-pending-sse";
import { enrichQaEntry } from "@app/dev-dashboard/lib/qa-render";
import { createQaStream } from "@app/dev-dashboard/lib/qa-sse";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { defaultDbPath } from "@app/question/commands/log";
import {
    answerAskForm,
    cancelAskForm,
    explainCancelRefusal,
    getAskForm,
    listPendingForms,
    pollAskForms,
    postAskForm,
    waitForAskForm,
} from "@app/question/lib/pending/ask";
import { type AskAnswer, type CreateAskFormInput, DEFAULT_WAIT_BUDGET_MS } from "@app/question/lib/pending/types";
import {
    getEntryById,
    markEntriesRead,
    markEntriesUnread,
    openReadModel,
    queryEntries,
} from "@app/question/lib/read-model";
import { getAudioLibrary } from "@genesiscz/utils/audio/library";
import { resolveSoundBuffer } from "@genesiscz/utils/audio/runner.server";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * `readJson` proves SYNTAX, not shape: `null`, `7` and `[]` are all valid JSON and none of
 * them is a body. Reading a field off one threw, and the route answered 500 for what is
 * plainly a client mistake.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a JSON OBJECT body, or the 400 that says why not.
 *
 * Shared so the three POST handlers cannot disagree: answering 400 for a malformed body on
 * one route and 500 on another is the same defect wearing two different status codes.
 * An absent body is `{}` here, because the adapter decodes it that way.
 */
async function readJsonObject<T extends object>(ctx: RouteContext): Promise<{ body: T } | { failure: RouteResult }> {
    let raw: unknown;

    try {
        raw = await ctx.readJson<unknown>();
    } catch (err) {
        return { failure: { kind: "json", status: 400, body: { error: `invalid JSON body: ${err}` } } };
    }

    // The guard proves it is an object. The generic only names the shape the caller then
    // validates for itself, exactly as it did when it called `readJson<T>` directly.
    if (!isJsonObject(raw)) {
        return { failure: { kind: "json", status: 400, body: { error: "expected a JSON object body" } } };
    }

    return { body: raw as T };
}

/**
 * How many waiting forms one snapshot carries. The store default is 50, which silently hid
 * the OLDEST pending forms once more than that were waiting: the newest 50 win the ORDER BY.
 */
const PENDING_SNAPSHOT_LIMIT = 500;

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

                    return { kind: "json", status: 200, body: { entries: rows.map((row) => clipQaEntry(row)) } };
                } catch (err) {
                    return errorResult(err);
                } finally {
                    db?.close(); // bun:sqlite has no GC finalizer — close every request or leak an FD (t1)
                }
            },
        },
        {
            // The whole entry, unclipped: what "load the full answer" and the copy buttons fetch.
            method: "GET",
            pattern: "/api/qa/entry/:id",
            handler: (ctx) => {
                let db: ReturnType<typeof openReadModel> | undefined;

                try {
                    db = openReadModel(defaultDbPath());
                    const row = getEntryById(db, ctx.params.id ?? "");

                    if (!row) {
                        return { kind: "json", status: 404, body: { error: `unknown entry: ${ctx.params.id}` } };
                    }

                    return { kind: "json", status: 200, body: { entry: row } };
                } catch (err) {
                    return errorResult(err);
                } finally {
                    db?.close();
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
                    emit.comment(" qa+handoff+pending multiplexed stream open");

                    // The tailer attaches BEFORE the snapshot is read. `FileTailer` starts at
                    // the current file size and never replays, so an event written between a
                    // snapshot-first read and the attach would be missing from BOTH sources: a
                    // form could stay hidden, or stay visible after it was answered, until the
                    // next reload. This order duplicates a frame instead, and the client folds
                    // by id, so a duplicate costs nothing.
                    const pendingStream = createPendingStream((event) =>
                        emit.data(
                            SafeJSON.stringify(
                                { type: "pending", ev: event.ev, id: event.id, ts: event.ts, form: event.form },
                                { strict: true }
                            )
                        )
                    );

                    // A client that connects while forms are already waiting must see them
                    // without a reload, exactly like the Genesis stream.
                    for (const form of listPendingForms(undefined, PENDING_SNAPSHOT_LIMIT)) {
                        emit.data(
                            SafeJSON.stringify({ type: "pending", ev: "created", id: form.id, form }, { strict: true })
                        );
                    }

                    const qaStream = createQaStream((entry) =>
                        emit.data(
                            SafeJSON.stringify({ type: "qa", ...enrichQaEntry(clipQaEntry(entry)) }, { strict: true })
                        )
                    );
                    const handoffStream = createHandoffStream((event) =>
                        emit.data(
                            SafeJSON.stringify(
                                { type: "handoff", id: event.id, ev: event.ev, ts: event.ts },
                                { strict: true }
                            )
                        )
                    );
                    const keepAlive = setInterval(() => emit.comment(" ping"), 12_000);

                    return {
                        close: () => {
                            clearInterval(keepAlive);
                            qaStream.close();
                            handoffStream.close();
                            pendingStream.close();
                        },
                    };
                },
            }),
        },
        {
            method: "GET",
            pattern: "/api/qa/pending",
            handler: (ctx) => {
                try {
                    const ids = ctx.query.get("ids");

                    if (ids) {
                        const wanted = ids
                            .split(",")
                            .map((id) => id.trim())
                            .filter((id) => id.length > 0);

                        return { kind: "json", status: 200, body: { forms: pollAskForms(wanted) } };
                    }

                    return {
                        kind: "json",
                        status: 200,
                        body: { forms: listPendingForms(undefined, PENDING_SNAPSHOT_LIMIT) },
                    };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/qa/pending",
            handler: async (ctx) => {
                try {
                    const read = await readJsonObject<CreateAskFormInput>(ctx);

                    if ("failure" in read) {
                        return read.failure;
                    }

                    const body = read.body;

                    if (!Array.isArray(body.items) || body.items.length === 0) {
                        return { kind: "json", status: 400, body: { error: "items[] is required" } };
                    }

                    // The body is an unchecked cast, so a number would crash `.trim()`. And this is a
                    // long-lived server: its own cwd is not the caller's project, so the caller names it.
                    if (typeof body.projectPath !== "string" || !body.projectPath.trim()) {
                        return {
                            kind: "json",
                            status: 400,
                            body: { error: "projectPath is required (a string naming the caller's project)" },
                        };
                    }

                    const form = await postAskForm(body, { ambient: false });

                    return { kind: "json", status: 201, body: { form } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/qa/pending/:id",
            handler: (ctx) => {
                try {
                    const form = getAskForm(ctx.params.id);

                    if (!form) {
                        return { kind: "json", status: 404, body: { error: `unknown form: ${ctx.params.id}` } };
                    }

                    return { kind: "json", status: 200, body: { form } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "DELETE",
            pattern: "/api/qa/pending/:id",
            handler: (ctx) => {
                try {
                    const form = cancelAskForm(ctx.params.id);

                    if (!form) {
                        // A form an answer holds still EXISTS, so 404 would tell a client to stop
                        // retrying something that is about to resolve. 409 says "busy, poll it".
                        const refusal = explainCancelRefusal(ctx.params.id);

                        return {
                            kind: "json",
                            status: refusal.code === "being_answered" ? 409 : 404,
                            body: { error: refusal.message, code: refusal.code },
                        };
                    }

                    return { kind: "json", status: 200, body: { form } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/qa/pending/:id/answer",
            handler: async (ctx) => {
                try {
                    const read = await readJsonObject<{ answers?: AskAnswer[] }>(ctx);

                    if ("failure" in read) {
                        return read.failure;
                    }

                    const outcome = await answerAskForm(ctx.params.id, read.body.answers ?? []);

                    if (!outcome.ok) {
                        // `incomplete` is the client's mistake (400); the others mean the form is
                        // gone or already resolved (404) — the same split Genesis' routes use.
                        const status = outcome.code === "incomplete" ? 400 : 404;

                        return { kind: "json", status, body: outcome };
                    }

                    return { kind: "json", status: 200, body: outcome };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/qa/pending/:id/wait",
            longLived: true,
            handler: async (ctx) => {
                try {
                    // An ABSENT body means "use the default budget", and the adapter decodes
                    // one as {}. A MALFORMED body used to be swallowed as {} too, which
                    // started a 120s wait on a typo: the caller heard about it two minutes
                    // later, as a timeout rather than as the input error it was.
                    const read = await readJsonObject<{ timeoutMs?: number }>(ctx);

                    if ("failure" in read) {
                        return read.failure;
                    }

                    const result = await waitForAskForm(ctx.params.id, read.body.timeoutMs ?? DEFAULT_WAIT_BUDGET_MS);

                    if (!result.form) {
                        return { kind: "json", status: 404, body: { error: `unknown form: ${ctx.params.id}` } };
                    }

                    return { kind: "json", status: 200, body: result };
                } catch (err) {
                    return errorResult(err);
                }
            },
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
