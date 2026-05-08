import { createFileRoute } from "@tanstack/react-router";
import logger from "@app/logger";
import { getSettingsRepository, type SettingsPatch } from "@app/shops/lib/settings";
import { apiHandler, safeJsonBody } from "../../server/api-utils";

const log = logger.child({ component: "api:settings" });

export const Route = createFileRoute("/api/settings")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const repo = getSettingsRepository();
                const settings = await repo.read();
                log.debug({}, "api: settings read");
                return Response.json(settings);
            }),
            PATCH: apiHandler(async (request) => {
                const body = await safeJsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const repo = getSettingsRepository();
                try {
                    const next = await repo.patch(body as SettingsPatch);
                    log.info({ keys: Object.keys(body) }, "api: settings patched");
                    return Response.json(next);
                } catch (err) {
                    const message = err instanceof Error ? err.message : "patch failed";
                    return Response.json({ error: message }, { status: 400 });
                }
            }),
        },
    },
});
