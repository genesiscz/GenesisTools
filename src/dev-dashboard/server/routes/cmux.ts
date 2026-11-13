import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { createDevDashboardTerminal } from "@app/dev-dashboard/lib/cmux/create-terminal";
import { createCmuxWorkspace } from "@app/dev-dashboard/lib/cmux/create-workspace";
import { enrichPanesWithTtyd, resolveTtydForCmuxSurface } from "@app/dev-dashboard/lib/cmux/enrich-ttyd";
import { getCachedSnapshot, markClientSeen } from "@app/dev-dashboard/lib/cmux/poller";
import { removeTmuxSessionFromCmux } from "@app/dev-dashboard/lib/cmux/remove-session";
import { sendTmuxSessionToCmux } from "@app/dev-dashboard/lib/cmux/send-session";
import { focusSessionPane } from "@app/dev-dashboard/lib/session-focus";
import { listTtyd, renameTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { bindHandler } from "@app/dev-dashboard/server/bind";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { fetchCmuxFullLayout } from "@genesiscz/utils/cmux/layout";
import { focusCmuxPane, renameCmuxSurface, renameCmuxWorkspace } from "@genesiscz/utils/cmux/lib/controls";
import type { DashboardSendTarget } from "@genesiscz/utils/cmux/types";
import { logger } from "@genesiscz/utils/logger";

export function cmuxRoutes(): RouteDef[] {
    return [
        // Enrich panes with the ttyd session id backing each tmux-session terminal, so a client can
        // open a cmux pane as a real terminal (not just focus it in the native cmux app).
        bindHandler(ENDPOINTS.cmuxSnapshot, async () => {
            markClientSeen();
            const snapshot = enrichPanesWithTtyd(getCachedSnapshot(), await listTtyd());

            return { kind: "json", status: 200, body: { snapshot } };
        }),
        bindHandler(ENDPOINTS.cmuxLayout, async () => {
            try {
                const layout = await fetchCmuxFullLayout();

                return { kind: "json", status: 200, body: { layout } };
            } catch (err) {
                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.cmuxCreateTerminal, async (ctx) => {
            try {
                const body = await ctx.readJson<{ cwd?: string }>();
                const result = await createDevDashboardTerminal({ cwd: body.cwd });

                return { kind: "json", status: 200, body: { result } };
            } catch (err) {
                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.cmuxCreateWorkspace, async (ctx) => {
            try {
                const body = await ctx.readJson<{ windowId: string; name?: string; cwd?: string }>();
                const result = await createCmuxWorkspace(body);

                return { kind: "json", status: 200, body: { result } };
            } catch (err) {
                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.cmuxSendSession, async (ctx) => {
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
        }),
        bindHandler(ENDPOINTS.cmuxRemoveSession, async (ctx) => {
            try {
                const body = await ctx.readJson<{ tmuxSessionName: string }>();
                const removed = await removeTmuxSessionFromCmux(body.tmuxSessionName);

                return { kind: "json", status: 200, body: { removed } };
            } catch (err) {
                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.cmuxAttach, async (ctx) => {
            try {
                const body = await ctx.readJson<{ workspaceId: string; paneId: string }>();
                await focusCmuxPane(body);

                return { kind: "json", status: 200, body: { ok: true } };
            } catch (err) {
                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.cmuxRename, async (ctx) => {
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

                    // One identity: cmux rename → ttyd display name + bound tmux session.
                    // Best-effort — never fails the cmux rename itself.
                    if (ttydId) {
                        try {
                            await renameTtyd(ttydId, body.title);
                        } catch (err) {
                            logger.debug({ err, ttydId }, "cmux rename: ttyd/tmux sync failed");
                        }
                    }
                } else {
                    await renameCmuxWorkspace({ workspaceId: body.workspaceId, title: body.title });
                }

                return { kind: "json", status: 200, body: { ok: true } };
            } catch (err) {
                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.cmuxFocusSession, async (ctx) => {
            try {
                const body = await ctx.readJson<{ sessionId?: string }>();
                const result = await focusSessionPane(body.sessionId ?? "");

                // A miss is a normal answer, not a server fault: the card must stay usable and
                // show the reason inline. 409 keeps it distinguishable from a 500.
                return { kind: "json", status: result.ok ? 200 : 409, body: result };
            } catch (err) {
                return errorResult(err);
            }
        }),
    ];
}
