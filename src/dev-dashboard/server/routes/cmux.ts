import { focusCmuxPane, renameCmuxSurface, renameCmuxWorkspace } from "@app/cmux/lib/controls";
import { createDevDashboardTerminal } from "@app/dev-dashboard/lib/cmux/create-terminal";
import { createCmuxWorkspace } from "@app/dev-dashboard/lib/cmux/create-workspace";
import { enrichPanesWithTtyd, resolveTtydForCmuxSurface } from "@app/dev-dashboard/lib/cmux/enrich-ttyd";
import { getCachedSnapshot } from "@app/dev-dashboard/lib/cmux/poller";
import { removeTmuxSessionFromCmux } from "@app/dev-dashboard/lib/cmux/remove-session";
import { sendTmuxSessionToCmux } from "@app/dev-dashboard/lib/cmux/send-session";
import { listTtyd, renameTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";
import { fetchCmuxFullLayout } from "@app/utils/cmux/layout";
import type { DashboardSendTarget } from "@app/utils/cmux/types";

export function cmuxRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/cmux/snapshot",
            // Enrich panes with the ttyd session id backing each tmux-session terminal, so a client can
            // open a cmux pane as a real terminal (not just focus it in the native cmux app).
            handler: async () => {
                const snapshot = enrichPanesWithTtyd(getCachedSnapshot(), await listTtyd());

                return { kind: "json", status: 200, body: { snapshot } };
            },
        },
        {
            method: "GET",
            pattern: "/api/cmux/layout",
            handler: async () => {
                try {
                    const layout = await fetchCmuxFullLayout();

                    return { kind: "json", status: 200, body: { layout } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/cmux/create-terminal",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ cwd?: string }>();
                    const result = await createDevDashboardTerminal({ cwd: body.cwd });

                    return { kind: "json", status: 200, body: { result } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/cmux/create-workspace",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ windowId: string; name?: string; cwd?: string }>();
                    const result = await createCmuxWorkspace(body);

                    return { kind: "json", status: 200, body: { result } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/cmux/send-session",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{
                        tmuxSessionName: string;
                        target: DashboardSendTarget;
                        cwd?: string;
                    }>();
                    const result = await sendTmuxSessionToCmux(body);

                    return { kind: "json", status: 200, body: { result } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/cmux/remove-session",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ tmuxSessionName: string }>();
                    const removed = await removeTmuxSessionFromCmux(body.tmuxSessionName);

                    return { kind: "json", status: 200, body: { removed } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/cmux/attach",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ workspaceId: string; paneId: string }>();
                    await focusCmuxPane(body);

                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/cmux/rename",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ workspaceId: string; surfaceId?: string; title: string }>();

                    if (body.surfaceId) {
                        // Resolve the ttyd terminal bound to this surface BEFORE renaming — the join is
                        // by the surface's current title (= tmux session name), which the rename changes.
                        const ttydId = resolveTtydForCmuxSurface(getCachedSnapshot(), body.surfaceId, await listTtyd());

                        await renameCmuxSurface({
                            workspaceId: body.workspaceId,
                            surfaceId: body.surfaceId,
                            title: body.title,
                        });

                        // A cmux rename is an explicit user action, so it sets the ttyd MANUAL name
                        // (same tier as the in-terminal pencil) — best-effort, never fails the rename.
                        if (ttydId) {
                            try {
                                await renameTtyd(ttydId, body.title);
                            } catch (err) {
                                logger.debug({ err, ttydId }, "cmux rename: ttyd display-name propagation failed");
                            }
                        }
                    } else {
                        await renameCmuxWorkspace({ workspaceId: body.workspaceId, title: body.title });
                    }

                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
