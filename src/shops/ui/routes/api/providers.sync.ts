import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { type SyncProviderResult, syncProvider } from "@app/shops/lib/order-sync";
import { realAuthClientFactory } from "@app/shops/lib/order-sync-clients";
import { authedApiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/providers/sync")({
    server: {
        handlers: {
            POST: authedApiHandler(async (request, userId) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const filter = typeof body.shop_origin === "string" ? body.shop_origin : null;
                const repo = new UserProvidersRepository(getShopsDatabase());
                const rows = await repo.listForUser(userId);
                const targets = rows.filter((r) => r.status === "connected" && (!filter || r.shop_origin === filter));

                const results: Array<{ shop_origin: string; result?: SyncProviderResult; error?: string }> = [];
                for (const provider of targets) {
                    try {
                        const result = await syncProvider({
                            userProviderId: provider.id,
                            factory: realAuthClientFactory,
                            limit: 20,
                        });
                        results.push({ shop_origin: provider.shop_origin, result });
                    } catch (err) {
                        results.push({
                            shop_origin: provider.shop_origin,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }

                return Response.json({ synced: results });
            }),
        },
    },
});
