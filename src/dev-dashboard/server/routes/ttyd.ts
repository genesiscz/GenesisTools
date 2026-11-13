import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { killTtyd, listTtyd, renameTtyd, spawnTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { bindHandler } from "@app/dev-dashboard/server/bind";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@genesiscz/utils/logger";

export function ttydRoutes(): RouteDef[] {
    return [
        bindHandler(ENDPOINTS.ttydList, async () => ({
            kind: "json",
            status: 200,
            body: { sessions: await listTtyd() },
        })),
        bindHandler(ENDPOINTS.ttydSpawn, async (ctx) => {
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
        }),
        bindHandler(ENDPOINTS.ttydKill, async (ctx) => {
            try {
                const body = await ctx.readJson<{ id: string; killTmux?: boolean }>();
                const ok = await killTtyd(body.id, { killTmux: body.killTmux === true });

                return { kind: "json", status: 200, body: { ok } };
            } catch (err) {
                logger.warn({ err, route: "POST /api/ttyd/kill" }, "tmux hub: ttyd kill failed");

                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.ttydRename, async (ctx) => {
            try {
                const body = await ctx.readJson<{ id: string; name: string }>();
                const ok = await renameTtyd(body.id, body.name);

                return { kind: "json", status: 200, body: { ok } };
            } catch (err) {
                logger.warn({ error: err, route: "POST /api/ttyd/rename" }, "tmux hub: ttyd rename failed");
                return errorResult(err);
            }
        }),
    ];
}
