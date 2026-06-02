import { createStandaloneTmuxSession } from "@app/dev-dashboard/lib/tmux/create-session";
import { enrichSessionsForHub } from "@app/dev-dashboard/lib/tmux/hub";
import { renameTmuxSessionInHub } from "@app/dev-dashboard/lib/tmux/rename";
import { listTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";
import { fetchCmuxFullLayout } from "@app/utils/cmux/layout";
import type { CmuxTmuxSurfaceRef } from "@app/utils/cmux/tmux-bindings";
import { indexCmuxSurfacesByTmuxSession } from "@app/utils/cmux/tmux-bindings";
import { listTmuxSessions } from "@app/utils/tmux/sessions";

export function tmuxRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/tmux/sessions",
            handler: async (ctx) => {
                // `?include=cmux` opts the caller into cmux-layout enrichment
                // (`cmuxSurfaces` + `inCmux`). The fetch is ~150ms even with previews
                // disabled (N+1 RPC over workspaces × panes × surfaces) and dwarfs
                // the rest of this endpoint (~3-5ms). Most consumers only need the
                // raw tmux session list, so the default is off and `enrichSessionsForHub`
                // emits `cmuxSurfaces: []` / `inCmux: false` for the missing fields.
                const include = (ctx.query.get("include") ?? "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                const includeCmux = include.includes("cmux");
                let cmuxBySession = new Map<string, CmuxTmuxSurfaceRef[]>();

                if (includeCmux) {
                    try {
                        // Skip preview capture — `indexCmuxSurfacesByTmuxSession` only reads
                        // workspace/surface ids+titles, never `preview`. Capturing the visible
                        // screen of each selected surface (the default) added ~600ms to this
                        // endpoint on a 12-workspace machine.
                        const layout = await fetchCmuxFullLayout({ includePreviews: false });

                        if (layout.available) {
                            cmuxBySession = indexCmuxSurfacesByTmuxSession(layout);
                        }
                    } catch (err) {
                        logger.debug({ err }, "tmux hub: cmux layout unavailable for enrichment");
                    }
                }

                const sessions = enrichSessionsForHub(listTmuxSessions(), await listTtyd(), cmuxBySession);

                return { kind: "json", status: 200, body: { sessions } };
            },
        },
        {
            method: "POST",
            pattern: "/api/tmux/create",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ name?: string; cwd?: string; command?: string }>();

                    return { kind: "json", status: 200, body: createStandaloneTmuxSession(body) };
                } catch (err) {
                    logger.warn({ err, route: "POST /api/tmux/create" }, "tmux hub: create session failed");

                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/tmux/rename",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ from: string; to: string }>();
                    const sessionName = await renameTmuxSessionInHub(body.from, body.to);

                    return { kind: "json", status: 200, body: { sessionName } };
                } catch (err) {
                    logger.warn({ err, route: "POST /api/tmux/rename" }, "tmux hub: rename session failed");

                    return errorResult(err);
                }
            },
        },
    ];
}
