import { addFavorite, addFavoriteByMaster } from "@app/shops/lib/watchlist-api";
import { authedApiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

interface BulkAddItem {
    master_product_id?: number;
    url?: string;
}

interface BulkAddResult {
    added: number;
    skipped_existing: number;
    errors: { input: BulkAddItem; error: string }[];
}

export const Route = createFileRoute("/api/watchlist/bulk-add")({
    server: {
        handlers: {
            POST: authedApiHandler(async (request, userId) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const items = Array.isArray(body.items) ? (body.items as BulkAddItem[]) : [];
                const result: BulkAddResult = { added: 0, skipped_existing: 0, errors: [] };
                for (const item of items) {
                    try {
                        if (typeof item.master_product_id === "number") {
                            await addFavoriteByMaster(userId, { master_product_id: item.master_product_id });
                            result.added++;
                            continue;
                        }

                        if (typeof item.url === "string" && item.url.length > 0) {
                            await addFavorite(userId, { url: item.url });
                            result.added++;
                            continue;
                        }

                        result.errors.push({ input: item, error: "missing master_product_id or url" });
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        if (msg.includes("UNIQUE")) {
                            result.skipped_existing++;
                            continue;
                        }

                        result.errors.push({ input: item, error: msg });
                    }
                }

                return Response.json(result);
            }),
        },
    },
});
