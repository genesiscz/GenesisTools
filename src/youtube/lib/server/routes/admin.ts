import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { buildBillingContext } from "@app/youtube/lib/billing";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { AdminListUsersOpts } from "@app/youtube/lib/db.types";
import { getLedgerPage } from "@app/youtube/lib/ledger-views";
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

            return Response.json({ users, total, limit: opts.limit, offset: opts.offset }, { headers: CORS_HEADERS });
        }

        const profile = matchRoute(req, "GET", "/api/v1/admin/users/:id", url.pathname);

        if (profile) {
            const admin = await requireAdmin(req, url, yt);

            if (admin instanceof Response) {
                return admin;
            }

            const userId = parseId(profile.id);
            const target = userId !== null ? yt.db.getUserById(userId) : null;

            if (!target) {
                return jsonError("user not found", 404);
            }

            const role = roleForEmail(await yt.config.get("powerUsers"), target.email);
            const billing = await buildBillingContext({ db: yt.db, config: yt.config, user: target });
            const totals = yt.db.adminUserTotals(target.id);

            return Response.json(
                {
                    user: target,
                    role,
                    billing,
                    totals: { ...totals, netUsd: totals.revenueCents / 100 - totals.aiCostUsd },
                    ledger: getLedgerPage(yt.db, target.id, { limit: 25 }).rows,
                    payments: yt.db.listPayments({ userId: target.id, limit: 50 }),
                    referral: buildAdminReferral(yt.db, target.id),
                    activity: {
                        watched: yt.db.listWatchesByUser(target.id, 30),
                        logs: yt.db.listVideoLogs({ userId: target.id, limit: 30 }),
                    },
                    jobs: yt.db.listJobs({ userId: target.id, limit: 20 }),
                },
                { headers: CORS_HEADERS }
            );
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

/** Admin sees full (unmasked) emails on both referral sides — they inspect everything. */
function buildAdminReferral(db: YoutubeDatabase, userId: number) {
    const code = db.getReferralCodeForUser(userId);
    const made = db.listReferralsByReferrer(userId);
    const referees = made.map((referral) => ({
        email: db.getUserEmailById(referral.refereeUserId) ?? "unknown",
        reward: referral.reward,
        redeemedAt: referral.createdAt,
    }));
    const totalEarned = made.reduce((sum, referral) => sum + referral.reward, 0);
    const referred = db.getReferralByReferee(userId);
    const referredBy = referred
        ? {
              email: db.getUserEmailById(referred.referrerUserId) ?? "unknown",
              reward: referred.reward,
              redeemedAt: referred.createdAt,
          }
        : null;

    return { code, referees, totalEarned, referredBy };
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

function parseId(value: string): number | null {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const id = Number(value);

    return Number.isSafeInteger(id) ? id : null;
}

function jsonError(error: string, status: number, code?: string): Response {
    const body = code ? { error, code } : { error };

    return new Response(SafeJSON.stringify(body, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
