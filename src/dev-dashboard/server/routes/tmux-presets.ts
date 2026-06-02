import { deletePreset, listPresets, restorePreset, savePreset } from "@app/dev-dashboard/lib/tmux/presets";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";

export function tmuxPresetsRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/tmux/presets",
            handler: () => {
                try {
                    return { kind: "json", status: 200, body: { presets: listPresets() } };
                } catch (err) {
                    logger.warn({ err, route: "GET /api/tmux/presets" }, "tmux presets: list failed");

                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/tmux/presets/save",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ name: string; note?: string; prefix?: string }>();

                    return { kind: "json", status: 200, body: { preset: savePreset(body) } };
                } catch (err) {
                    logger.warn({ err, route: "POST /api/tmux/presets/save" }, "tmux presets: save failed");

                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/tmux/presets/restore",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ name: string }>();

                    return { kind: "json", status: 200, body: { result: restorePreset(body.name) } };
                } catch (err) {
                    logger.warn({ err, route: "POST /api/tmux/presets/restore" }, "tmux presets: restore failed");

                    return errorResult(err);
                }
            },
        },
        {
            method: "DELETE",
            pattern: "/api/tmux/presets",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ name: string }>();

                    return { kind: "json", status: 200, body: deletePreset(body.name) };
                } catch (err) {
                    logger.warn({ err, route: "DELETE /api/tmux/presets" }, "tmux presets: delete failed");

                    return errorResult(err);
                }
            },
        },
    ];
}
