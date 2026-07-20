import { readFileSync } from "node:fs";
import { getConfig } from "@app/dev-dashboard/config";
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
import { normalizeHandoffId } from "@app/handoff/ids";
import { catchUpHandoffs, getHandoffById, listHandoffEvents, openHandoffModel } from "@app/handoff/read-model";
import type { HandoffActionInput, HandoffEventBy, HandoffTarget, HandoffTaskInput } from "@app/handoff/types";

/**
 * Dashboard actor (G7): sessionTitle = configured Basic Auth username;
 * fallback "dev-dashboard" when auth is disabled. Keep agent/via for isHumanOwner.
 */
export function dashboardActor(sessionTitle?: string): HandoffEventBy {
    return {
        ...DASHBOARD_ACTOR,
        sessionTitle:
            sessionTitle !== undefined && sessionTitle.trim().length > 0 ? sessionTitle.trim() : "dev-dashboard",
    };
}

async function dashboardDeps(): Promise<HandoffDeps> {
    const config = await getConfig();
    const title =
        config.auth.enabled && config.auth.username.trim().length > 0 ? config.auth.username : "dev-dashboard";
    return { by: dashboardActor(title) };
}

export function handoffRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/handoff/log",
            handler: async (ctx) => {
                try {
                    const deps = await dashboardDeps();
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
            handler: async (ctx) => {
                try {
                    const deps = await dashboardDeps();
                    const id = ctx.query.get("id") ?? "";
                    const res = getHandoff({ id }, deps);

                    return { kind: "json", status: 200, body: res };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/handoff/events",
            handler: (ctx) => {
                try {
                    const id = normalizeHandoffId(ctx.query.get("id") ?? "");
                    const limitRaw = ctx.query.get("limit");
                    const limit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : 200;
                    const before = ctx.query.get("before") ?? undefined;

                    if (id.length === 0) {
                        return { kind: "json", status: 400, body: { error: "id query param required" } };
                    }

                    const db = openHandoffModel();

                    try {
                        catchUpHandoffs(db);

                        if (getHandoffById(db, id) === null) {
                            return {
                                kind: "json",
                                status: 404,
                                body: { error: `No handoff ${id} — re-check the paste block or call handoff_list` },
                            };
                        }

                        const body = listHandoffEvents({ db, handoffId: id, limit, before });
                        return { kind: "json", status: 200, body };
                    } finally {
                        db.close();
                    }
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
                    const deps = await dashboardDeps();
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
                    const deps = await dashboardDeps();
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
                    const deps = await dashboardDeps();
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
            handler: async (ctx) => {
                try {
                    const deps = await dashboardDeps();
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
    ];
}
