import { createFileRoute } from "@tanstack/react-router";
import { rejectCandidatePair } from "@app/shops/lib/match-api";
import { apiHandler } from "@app/shops/ui/server/api-utils";

function parsePair(slug: string): { a: number; b: number } | null {
    const [a, b] = slug.split("-").map(Number);
    if (Number.isNaN(a) || Number.isNaN(b)) {
        return null;
    }

    return { a, b };
}

export const Route = createFileRoute("/api/match/$candidate/reject")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const url = new URL(request.url);
                const slug = url.pathname.split("/").at(-2) ?? "";
                const pair = parsePair(slug);
                if (!pair) {
                    return Response.json({ error: "Invalid candidate id" }, { status: 400 });
                }

                await rejectCandidatePair({ productIdA: pair.a, productIdB: pair.b });
                return Response.json({ ok: true });
            }),
        },
    },
});
