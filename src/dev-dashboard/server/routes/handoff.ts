import { readFileSync } from "node:fs";
import { createHandoffStream } from "@app/dev-dashboard/lib/handoff-sse";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { MAX_ATTACHMENT_BYTES } from "@app/handoff/attachments";
import {
    attachHandoffBytes,
    DASHBOARD_ACTOR,
    executeHandoffActions,
    getHandoff,
    type HandoffDeps,
    listHandoffs,
    postHandoff,
    resolveAttachment,
} from "@app/handoff/executor";
import type { HandoffActionInput, HandoffTarget, HandoffTaskInput } from "@app/handoff/types";
import { SafeJSON } from "@genesiscz/utils/json";

/** Every UI-originated event runs with owner authority and is visibly attributed (§7.1). */
const deps: HandoffDeps = { by: DASHBOARD_ACTOR };

export function handoffRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/handoff/log",
            handler: (ctx) => {
                try {
                    const limitRaw = ctx.query.get("limit");
                    const offsetRaw = ctx.query.get("offset");
                    const res = listHandoffs(
                        {
                            limit: limitRaw !== null ? Number.parseInt(limitRaw, 10) : 100,
                            offset: offsetRaw !== null ? Number.parseInt(offsetRaw, 10) : undefined,
                            open: ctx.query.get("open") === "1",
                            project: ctx.query.get("project") ?? undefined,
                        },
                        deps
                    );

                    return { kind: "json", status: 200, body: res };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/handoff/get",
            handler: (ctx) => {
                try {
                    const id = ctx.query.get("id") ?? "";
                    const res = getHandoff({ id }, deps);

                    return { kind: "json", status: 200, body: res };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/handoff/action",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ id?: string; editId?: string; actions?: HandoffActionInput[] }>();
                    const res = executeHandoffActions(
                        { id: body.id ?? "", editId: body.editId, actions: body.actions ?? [] },
                        deps
                    );

                    return { kind: "json", status: 200, body: res };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/handoff/post",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        title?: string;
                        description?: string;
                        tasks?: HandoffTaskInput[];
                        target?: HandoffTarget;
                        refs?: string[];
                    }>();
                    const res = postHandoff(
                        {
                            title: body.title ?? "",
                            description: body.description,
                            tasks: body.tasks ?? [],
                            target: body.target,
                            refs: body.refs,
                        },
                        deps
                    );

                    return { kind: "json", status: 200, body: res };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/handoff/attach",
            handler: async (ctx) => {
                try {
                    const id = ctx.query.get("id") ?? "";
                    const filename = ctx.query.get("filename") ?? "pasted.bin";
                    const taskId = ctx.query.get("taskId") ?? undefined;
                    const note = ctx.query.get("note") ?? undefined;
                    const contentLength = ctx.headers["content-length"];

                    if (contentLength !== undefined && Number.parseInt(contentLength, 10) > MAX_ATTACHMENT_BYTES) {
                        return {
                            kind: "json",
                            status: 413,
                            body: { error: `attachment declares ${contentLength} bytes — the cap is 10 MB` },
                        };
                    }

                    const bytes = await ctx.readRawBody();

                    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
                        return {
                            kind: "json",
                            status: 413,
                            body: { error: `attachment is ${bytes.byteLength} bytes — the cap is 10 MB` },
                        };
                    }

                    const res = attachHandoffBytes({ id, filename, bytes, taskId, note }, deps);

                    return { kind: "json", status: 200, body: res };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/handoff/attachment",
            handler: (ctx) => {
                try {
                    const attachmentId = ctx.query.get("id") ?? "";
                    const resolved = resolveAttachment(attachmentId, deps);

                    if (resolved === null) {
                        return { kind: "json", status: 404, body: { error: `unknown attachment: ${attachmentId}` } };
                    }

                    if (resolved.missing) {
                        return {
                            kind: "json",
                            status: 410,
                            body: { error: `attachment file missing on disk: ${attachmentId}` },
                        };
                    }

                    const safeName = resolved.filename.replace(/"/g, "");
                    // SVG is a scriptable same-origin document even with nosniff — force it to download.
                    const inlineOk = resolved.mime.startsWith("image/") && resolved.mime !== "image/svg+xml";
                    const disposition = inlineOk ? "inline" : "attachment";

                    return {
                        kind: "binary",
                        status: 200,
                        contentType: resolved.mime,
                        body: readFileSync(resolved.path),
                        headers: {
                            "Cache-Control": "public, max-age=31536000, immutable",
                            "Content-Disposition": `${disposition}; filename="${safeName}"`,
                            "X-Content-Type-Options": "nosniff",
                        },
                    };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/handoff/stream",
            longLived: true,
            handler: () => ({
                kind: "sse",
                start: (emit) => {
                    emit.comment(" handoff stream open");
                    const stream = createHandoffStream((event) =>
                        emit.data(SafeJSON.stringify({ id: event.id, ev: event.ev, ts: event.ts }, { strict: true }))
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
    ];
}
