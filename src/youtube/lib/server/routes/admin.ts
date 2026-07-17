import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { AdminListUsersOpts } from "@app/youtube/lib/db.types";
import { isPowerRole, roleForEmail } from "@app/youtube/lib/roles";
import { requireUser } from "@app/youtube/lib/server/auth";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { YtUser } from "@app/youtube/lib/users.types";
import type { Youtube } from "@app/youtube/lib/youtube";

const USER_SORTS = new Set(["created", "revenue", "net", "credits"]);

/**
 * Admin gate: 401 login_required for anonymous (via requireUser), then 403
 * {code:"forbidden"} for authed non-power users. Returns the YtUser on success.
 */
async function requireAdmin(req: Request, url: URL, yt: Youtube): Promise<YtUser | Response> {
    const user = requireUser(req, url, yt.db);

    if (user instanceof Response) {
        return user;
    }

    const role = roleForEmail(await yt.config.get("powerUsers"), user.email);

    if (!isPowerRole(role)) {
        logger.debug({ userId: user.id, role }, "admin route: rejected non-power user");

        return jsonError("admin access required", 403, "forbidden");
    }

    return user;
}

export async function handleAdminRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (matchRoute(req, "GET", "/api/v1/admin/users", url.pathname)) {
            const user = await requireAdmin(req, url, yt);

            if (user instanceof Response) {
                return user;
            }

            const opts = parseListUsersOpts(url);
            const { rows, total } = yt.db.adminListUsers(opts);
            const powerUsers = await yt.config.get("powerUsers");
            const users = rows.map((row) => ({
                id: row.id,
                email: row.email,
                role: roleForEmail(powerUsers, row.email),
                credits: row.credits,
                revenueCents: row.revenueCents,
                aiCostUsd: row.aiCostUsd,
                netUsd: row.revenueCents / 100 - row.aiCostUsd,
                subscription: row.subStatus ? { planId: row.subPlanId, status: row.subStatus } : null,
                createdAt: row.createdAt,
                lastLoginAt: row.lastLoginAt,
            }));

            return Response.json(
                { users, total, limit: opts.limit, offset: opts.offset },
                { headers: CORS_HEADERS }
            );
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function parseListUsersOpts(url: URL): AdminListUsersOpts & { limit: number; offset: number } {
    const search = url.searchParams.get("q")?.trim() || undefined;
    const subscription = url.searchParams.get("subscription")?.trim() || undefined;
    const rawSort = url.searchParams.get("sort") ?? "";
    const sort = (USER_SORTS.has(rawSort) ? rawSort : "created") as AdminListUsersOpts["sort"];
    const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
    const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

    return { search, subscription, sort, dir, limit, offset };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);

    if (Number.isNaN(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

function jsonError(error: string, status: number, code?: string): Response {
    const body = code ? { error, code } : { error };

    return new Response(SafeJSON.stringify(body, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
