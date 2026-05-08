import { createFileRoute } from "@tanstack/react-router";
import logger from "@app/logger";
import { getSettingsRepository } from "@app/shops/lib/settings";
import { apiHandler } from "../../server/api-utils";

const log = logger.child({ component: "api:daemon" });

export const Route = createFileRoute("/api/daemon")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const repo = getSettingsRepository();
                const settings = await repo.read();
                log.debug({ enabled: settings.daemon_enabled }, "api: daemon status");
                return Response.json({
                    enabled: settings.daemon_enabled,
                    pid: null,
                    uptime_seconds: null,
                });
            }),
            POST: apiHandler(async (request) => {
                const url = new URL(request.url);
                const action = url.searchParams.get("action");
                if (action !== "enable" && action !== "disable") {
                    return Response.json(
                        { error: "action must be enable|disable" },
                        { status: 400 },
                    );
                }

                const repo = getSettingsRepository();
                const next = await repo.patch({ daemon_enabled: action === "enable" });
                log.info({ action }, "api: daemon toggle");
                return Response.json({ enabled: next.daemon_enabled });
            }),
        },
    },
});
