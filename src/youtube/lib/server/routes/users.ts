import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { createCheckoutSession } from "@app/youtube/lib/billing";
import { DIAMOND_PACKS } from "@app/youtube/lib/billing.types";
import { requireUser } from "@app/youtube/lib/server/auth";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import { loginUser, registerUser } from "@app/youtube/lib/users";
import type { Youtube } from "@app/youtube/lib/youtube";

export async function handleUsersRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (matchRoute(req, "POST", "/api/v1/users/register", url.pathname)) {
            const credentials = await parseCredentials(req);

            if (!credentials) {
                return jsonError("body must include {email: string, password: string}", 400);
            }

            try {
                const result = await registerUser(yt.db, credentials);
                return Response.json(result, { headers: CORS_HEADERS });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return jsonError(message, message.includes("already exists") ? 409 : 400);
            }
        }

        if (matchRoute(req, "POST", "/api/v1/users/login", url.pathname)) {
            const credentials = await parseCredentials(req);

            if (!credentials) {
                return jsonError("body must include {email: string, password: string}", 400);
            }

            try {
                const result = await loginUser(yt.db, credentials);
                return Response.json(result, { headers: CORS_HEADERS });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return jsonError(message, message === "Invalid email or password" ? 401 : 400);
            }
        }

        if (matchRoute(req, "GET", "/api/v1/users/me", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            return Response.json({ user }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "POST", "/api/v1/users/topup", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            // Dev stand-in for Stripe: accepted unconditionally on this
            // localhost tool; the extension gates the button to dev builds.
            const body = (await safeJsonBody(req)) ?? {};
            const requested = typeof body.amount === "number" ? Math.floor(body.amount) : 100;
            const amount = Math.min(10_000, Math.max(1, requested));
            const credits = yt.db.grantCredits(user.id, amount, "dev-topup");

            return Response.json({ user: { ...user, credits } }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "POST", "/api/v1/users/checkout", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            if (!env.stripe.getSecretKey()) {
                return jsonError("billing not configured", 503);
            }

            const body = (await safeJsonBody(req)) ?? {};
            const packId = typeof body.packId === "string" ? body.packId : null;

            if (!packId || !DIAMOND_PACKS.some((pack) => pack.id === packId)) {
                return jsonError("body must include a known {packId}", 400);
            }

            try {
                const origin = req.headers.get("Origin") ?? "https://www.youtube.com";
                const result = await createCheckoutSession({ user, packId, origin });
                return Response.json(result, { headers: CORS_HEADERS });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn({ error, userId: user.id, packId }, "youtube billing: checkout session failed");
                return jsonError(message, message.includes("not configured") ? 503 : 400);
            }
        }

        if (matchRoute(req, "GET", "/api/v1/users/qa-history", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const video = url.searchParams.get("video") ?? undefined;
            const rawLimit = url.searchParams.get("limit");
            const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;
            const items = yt.db.listQaHistory(user.id, video, Number.isNaN(limit) ? undefined : limit);

            return Response.json({ items }, { headers: CORS_HEADERS });
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

async function parseCredentials(req: Request): Promise<{ email: string; password: string } | null> {
    const body = await safeJsonBody(req);

    if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
        return null;
    }

    return { email: body.email, password: body.password };
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

async function safeJsonBody(req: Request): Promise<Record<string, unknown> | null> {
    if (!req.headers.get("content-type")?.includes("application/json")) {
        return null;
    }

    try {
        const parsed = await req.json();

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // non-JSON body — caller treats null as "no body"
    }

    return null;
}
