import { matchRoute } from "@app/youtube/lib/server/match-route";
import { renderShareNotFoundPage, renderSharePage } from "@app/youtube/lib/shares";
import type { Youtube } from "@app/youtube/lib/youtube";

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

/**
 * Public, unauthenticated `GET /share/:slug` — no `/api` prefix, registered
 * directly in `server/index.ts` before the `/api/v1/*` dispatch (and exempt
 * from service-key auth, alongside webhooks). Returns `null` for any other
 * path so the caller falls through to the rest of the route table.
 */
export function handleSharePageRoute(req: Request, url: URL, yt: Youtube): Response | null {
    const params = matchRoute(req, "GET", "/share/:slug", url.pathname);

    if (!params) {
        return null;
    }

    const share = yt.db.getShareBySlug(params.slug);

    if (!share || share.revoked_at) {
        return new Response(renderShareNotFoundPage(), { status: 404, headers: HTML_HEADERS });
    }

    return new Response(renderSharePage(share), { status: 200, headers: HTML_HEADERS });
}
