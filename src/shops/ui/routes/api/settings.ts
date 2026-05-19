import { logger } from "@app/logger";
import { getSettingsRepository, type SettingsPatch } from "@app/shops/lib/settings";
import { authedApiHandler, safeJsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

const log = logger.child({ component: "api:settings" });

export const Route = createFileRoute("/api/settings")({
    server: {
        handlers: {
            GET: authedApiHandler(async (_request, userId) => {
                const repo = getSettingsRepository();
                const settings = await repo.read(userId);
                log.debug({ userId }, "api: settings read");
                return Response.json(settings);
            }),
            PATCH: authedApiHandler(async (request, userId) => {
                const body = await safeJsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const repo = getSettingsRepository();
                try {
                    const next = await repo.patch(userId, body as SettingsPatch);
                    log.info({ userId, keys: Object.keys(body) }, "api: settings patched");
                    return Response.json(next);
                } catch (err) {
                    const message = err instanceof Error ? err.message : "patch failed";
                    return Response.json({ error: message }, { status: 400 });
                }
            }),
        },
    },
});
