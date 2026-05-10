import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { authedApiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

const SUPPORTED = ["rohlik.cz", "kosik.cz"] as const;

export const Route = createFileRoute("/api/providers/list")({
    server: {
        handlers: {
            GET: authedApiHandler(async (_request, userId) => {
                const db = getShopsDatabase();
                const repo = new UserProvidersRepository(db);
                const rows = await repo.listForUser(userId);
                const byOrigin = new Map(rows.map((r) => [r.shop_origin, r]));
                const cards = SUPPORTED.map((origin) => {
                    const row = byOrigin.get(origin);
                    return {
                        shop_origin: origin,
                        display_name: row?.display_name ?? (origin === "rohlik.cz" ? "Rohlík.cz" : "Košík.cz"),
                        status: row?.status ?? "disconnected",
                        external_user_email: row?.external_user_email ?? null,
                        last_sync_at: row?.last_sync_at ?? null,
                        last_sync_error: row?.last_sync_error ?? null,
                        auto_watchlist: (row?.auto_watchlist ?? 0) === 1,
                        supports_auto_login: origin === "rohlik.cz",
                    };
                });
                return Response.json(cards);
            }),
        },
    },
});
