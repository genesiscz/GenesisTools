import logger from "@app/logger";
import { getSettingsRepository } from "@app/shops/lib/settings";
import { authedApiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

const log = logger.child({ component: "api:daemon" });

export const Route = createFileRoute("/api/daemon")({
    server: {
        handlers: {
            GET: authedApiHandler(async (_request, userId) => {
                const repo = getSettingsRepository();
                const settings = await repo.read(userId);
                log.debug({ enabled: settings.daemon_enabled, userId }, "api: daemon status");
                return Response.json({
                    enabled: settings.daemon_enabled,
                    pid: null,
                    uptime_seconds: null,
                });
            }),
            POST: authedApiHandler(async (request, userId) => {
                const url = new URL(request.url);
                const action = url.searchParams.get("action");
                if (action !== "enable" && action !== "disable") {
                    return Response.json({ error: "action must be enable|disable" }, { status: 400 });
                }

                const repo = getSettingsRepository();
                const next = await repo.patch(userId, { daemon_enabled: action === "enable" });
                log.info({ action, userId }, "api: daemon toggle");
                return Response.json({ enabled: next.daemon_enabled });
            }),
        },
    },
});
