import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isPowerRole, roleForEmail } from "@app/youtube/lib/roles";
import { resolveUser } from "@app/youtube/lib/server/auth";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import type { Youtube } from "@app/youtube/lib/youtube";

/**
 * Operator gate for operator-only routes (server config, cache maintenance).
 *
 * The global `requireServiceKey` gate already admitted this request as EITHER a
 * valid service key / open mode OR a valid `ytu_` user token — so here we only
 * close the user-token hole: a plain user token must not reach operator routes.
 * A real service key (no resolvable user) and open mode (localhost dev, no
 * token) proceed; a `ytu_` token proceeds only for admin/dev roles.
 *
 * Returns `null` to proceed, or a ready 403 `{code:"forbidden"}` Response.
 */
export async function requireOperator(req: Request, url: URL, yt: Youtube): Promise<Response | null> {
    const user = resolveUser(req, url, yt.db);

    if (!user) {
        return null;
    }

    const role = roleForEmail(await yt.config.get("powerUsers"), user.email);

    if (!isPowerRole(role)) {
        logger.debug({ userId: user.id, role, path: url.pathname }, "operator route: rejected non-power user token");

        return new Response(
            SafeJSON.stringify({ error: "operator access required", code: "forbidden" }, { strict: true }),
            { status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
    }

    return null;
}
