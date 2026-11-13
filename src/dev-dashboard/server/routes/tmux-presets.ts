import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { deletePreset, listPresets, restorePreset, savePreset } from "@app/dev-dashboard/lib/tmux/presets";
import { bindHandler } from "@app/dev-dashboard/server/bind";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@genesiscz/utils/logger";

export function tmuxPresetsRoutes(): RouteDef[] {
    return [
        bindHandler(ENDPOINTS.tmuxPresets, () => {
            try {
                return { kind: "json", status: 200, body: { presets: listPresets() } };
            } catch (err) {
                logger.warn({ err, route: "GET /api/tmux/presets" }, "tmux presets: list failed");

                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.tmuxPresetSave, async (ctx) => {
            try {
                const body = await ctx.readJson<{ name: string; note?: string; prefix?: string }>();

                if (!body.name?.trim()) {
                    return { kind: "json", status: 400, body: { error: "name is required" } };
                }

                return { kind: "json", status: 200, body: { preset: await savePreset(body) } };
            } catch (err) {
                logger.warn({ err, route: "POST /api/tmux/presets/save" }, "tmux presets: save failed");

                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.tmuxPresetRestore, async (ctx) => {
            try {
                const body = await ctx.readJson<{ name: string }>();

                if (!body.name?.trim()) {
                    return { kind: "json", status: 400, body: { error: "name is required" } };
                }

                return { kind: "json", status: 200, body: { result: await restorePreset(body.name) } };
            } catch (err) {
                logger.warn({ err, route: "POST /api/tmux/presets/restore" }, "tmux presets: restore failed");

                return errorResult(err);
            }
        }),
        bindHandler(ENDPOINTS.tmuxPresetDelete, async (ctx) => {
            try {
                const body = await ctx.readJson<{ name: string }>();

                if (!body.name?.trim()) {
                    return { kind: "json", status: 400, body: { error: "name is required" } };
                }

                return { kind: "json", status: 200, body: deletePreset(body.name) };
            } catch (err) {
                logger.warn({ err, route: "DELETE /api/tmux/presets" }, "tmux presets: delete failed");

                return errorResult(err);
            }
        }),
    ];
}
