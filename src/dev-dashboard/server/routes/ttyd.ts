import { killTtyd, listTtyd, renameTtyd, spawnTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";

export function ttydRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/ttyd/list",
            handler: async () => ({ kind: "json", status: 200, body: { sessions: await listTtyd() } }),
        },
        {
            method: "POST",
            pattern: "/api/ttyd/spawn",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ command?: string; cwd?: string; tmuxSessionName?: string }>();
                    const session = await spawnTtyd({
                        command: body.command,
                        cwd: body.cwd,
                        attachTmuxSession: body.tmuxSessionName,
                    });

                    return { kind: "json", status: 200, body: { session } };
                } catch (err) {
                    const statusCode = (err as Error & { statusCode?: number }).statusCode;
                    logger.warn({ err, route: "POST /api/ttyd/spawn", statusCode }, "tmux hub: ttyd spawn failed");

                    return errorResult(err, statusCode === 409 ? 409 : 500);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/ttyd/kill",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ id: string; killTmux?: boolean }>();
                    const ok = await killTtyd(body.id, { killTmux: body.killTmux === true });

                    return { kind: "json", status: 200, body: { ok } };
                } catch (err) {
                    logger.warn({ err, route: "POST /api/ttyd/kill" }, "tmux hub: ttyd kill failed");

                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/ttyd/rename",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ id: string; name: string }>();
                    const ok = await renameTtyd(body.id, body.name);

                    return { kind: "json", status: 200, body: { ok } };
                } catch (err) {
                    logger.warn({ error: err, route: "POST /api/ttyd/rename" }, "tmux hub: ttyd rename failed");
                    return errorResult(err);
                }
            },
        },
    ];
}
