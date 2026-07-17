import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { createCheckoutSession } from "@app/youtube/lib/billing";
import { DIAMOND_PACKS } from "@app/youtube/lib/billing.types";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import { buildHistoryEntries, groupHistoryByAction, groupHistoryByVideo } from "@app/youtube/lib/history";
import { isOutputLang } from "@app/youtube/lib/languages";
import { getLedgerPage, getUsageSummary } from "@app/youtube/lib/ledger-views";
import { createPreset, deletePreset, listPresets, updatePreset } from "@app/youtube/lib/presets";
import type { PresetKind } from "@app/youtube/lib/presets.types";
import { roleForEmail } from "@app/youtube/lib/roles";
import { requireUser } from "@app/youtube/lib/server/auth";
import { safeJsonBody } from "@app/youtube/lib/server/body";
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

            const role = roleForEmail(await yt.config.get("powerUsers"), user.email);

            return Response.json({ user, role }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "PATCH", "/api/v1/users/me", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const body = (await safeJsonBody(req)) ?? {};

            if (typeof body.outputLang === "string" && !isOutputLang(body.outputLang)) {
                return jsonError("unknown outputLang", 400);
            }

            const patched = yt.db.updateUserPrefs(user.id, {
                outputLang: typeof body.outputLang === "string" ? body.outputLang : undefined,
                ttsVoice: typeof body.ttsVoice === "string" ? body.ttsVoice : undefined,
            });

            return Response.json({ user: patched }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "POST", "/api/v1/users/topup", url.pathname)) {
            // Dev stand-in for Stripe: server-gated by YOUTUBE_ALLOW_DEV_TOPUP
            // so a deployed build cannot mint credits outside real billing.
            if (!env.youtube.isDevTopupAllowed()) {
                return jsonError("not found", 404);
            }

            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

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

        if (matchRoute(req, "GET", "/api/v1/users/ledger", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const rawLimit = url.searchParams.get("limit");
            const rawBefore = url.searchParams.get("before");
            const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;
            const before = rawBefore ? parseInt(rawBefore, 10) : undefined;
            const page = getLedgerPage(yt.db, user.id, {
                limit: limit !== undefined && !Number.isNaN(limit) ? limit : undefined,
                before: before !== undefined && !Number.isNaN(before) ? before : undefined,
            });

            return Response.json(page, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "GET", "/api/v1/users/usage-summary", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const summary = getUsageSummary(yt.db, user.id);

            return Response.json(summary, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "GET", "/api/v1/users/presets", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const kind = parsePresetKind(url.searchParams.get("kind"));
            const presets = listPresets(yt.db, user.id, kind);

            return Response.json({ presets }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "POST", "/api/v1/users/presets", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const body = (await safeJsonBody(req)) ?? {};
            const kind = parsePresetKind(body.kind);

            if (!kind || typeof body.name !== "string" || typeof body.instructions !== "string") {
                return jsonError("body must include {name, kind, instructions}", 400);
            }

            try {
                const preset = createPreset(yt.db, user.id, { name: body.name, kind, instructions: body.instructions });
                return Response.json({ preset }, { headers: CORS_HEADERS });
            } catch (error) {
                const { message, status } = presetErrorResponse(error);
                return jsonError(message, status);
            }
        }

        const presetUpdate = matchRoute(req, "PUT", "/api/v1/users/presets/:id", url.pathname);

        if (presetUpdate) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = parsePresetId(presetUpdate.id);

            if (id === null) {
                return jsonError("invalid preset id", 400);
            }

            const body = (await safeJsonBody(req)) ?? {};
            const name = typeof body.name === "string" ? body.name : undefined;
            const instructions = typeof body.instructions === "string" ? body.instructions : undefined;

            try {
                const preset = updatePreset(yt.db, user.id, id, { name, instructions });
                return Response.json({ preset }, { headers: CORS_HEADERS });
            } catch (error) {
                const { message, status } = presetErrorResponse(error);
                return jsonError(message, status);
            }
        }

        const presetDelete = matchRoute(req, "DELETE", "/api/v1/users/presets/:id", url.pathname);

        if (presetDelete) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const id = parsePresetId(presetDelete.id);

            if (id === null) {
                return jsonError("invalid preset id", 400);
            }

            try {
                deletePreset(yt.db, user.id, id);
                return Response.json({ deleted: true }, { headers: CORS_HEADERS });
            } catch (error) {
                const { message, status } = presetErrorResponse(error);
                return jsonError(message, status);
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

        if (matchRoute(req, "GET", "/api/v1/users/history", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const groupBy = url.searchParams.get("groupBy") === "action" ? "action" : "video";
            const rawLimit = parseInt(url.searchParams.get("limit") ?? "500", 10);
            const limit = Number.isNaN(rawLimit) ? 500 : Math.min(2000, Math.max(1, rawLimit));
            const entries = buildHistoryEntries(yt.db, user.id, limit);
            const videoIds = [...new Set(entries.map((entry) => entry.videoId))];
            const videosById = Object.fromEntries(yt.db.getVideosByIds(videoIds).map((video) => [video.id, video]));

            if (groupBy === "action") {
                return Response.json(
                    { groupBy, actions: groupHistoryByAction(entries), videosById },
                    { headers: CORS_HEADERS }
                );
            }

            return Response.json(
                { groupBy, videos: groupHistoryByVideo(entries), videosById },
                { headers: CORS_HEADERS }
            );
        }

        if (matchRoute(req, "GET", "/api/v1/users/watchlist", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            return Response.json({ channels: yt.db.listWatchlist(user.id) }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "POST", "/api/v1/users/watchlist", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const body = (await safeJsonBody(req)) ?? {};
            const handle = typeof body.handle === "string" ? body.handle.trim() : "";

            if (!handle.startsWith("@") || handle.length < 2) {
                return jsonError("body must include {handle: '@channel'}", 400);
            }

            yt.db.addWatchlistChannel(user.id, handle);

            return Response.json({ added: true }, { headers: CORS_HEADERS });
        }

        const watchlistRemove = matchRoute(req, "DELETE", "/api/v1/users/watchlist/:handle", url.pathname);

        if (watchlistRemove) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            return Response.json(
                { removed: yt.db.removeWatchlistChannel(user.id, decodeURIComponent(watchlistRemove.handle)) },
                { headers: CORS_HEADERS }
            );
        }

        if (matchRoute(req, "GET", "/api/v1/users/digest", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const rawDays = parseInt(url.searchParams.get("sinceDays") ?? "7", 10);
            const sinceDays = Number.isNaN(rawDays) ? 7 : Math.min(3650, Math.max(1, rawDays));
            const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const channels = yt.db.listWatchlist(user.id).map((entry) => {
                const videos = yt.videos.list({ channel: entry.channelHandle as ChannelHandle, since, limit: 50 });

                return { handle: entry.channelHandle, videos: yt.db.getVideosByIds(videos.map((video) => video.id)) };
            });

            return Response.json({ since, channels }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "POST", "/api/v1/users/digest/sync", url.pathname)) {
            const user = requireUser(req, url, yt.db);

            if (user instanceof Response) {
                return user;
            }

            const enqueuedJobIds = yt.db.listWatchlist(user.id).map(
                (entry) =>
                    yt.pipeline.enqueue({
                        targetKind: "channel",
                        target: entry.channelHandle,
                        stages: ["discover", "metadata"],
                        userId: user.id,
                    }).id
            );

            return Response.json({ enqueuedJobIds }, { headers: CORS_HEADERS });
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

function parsePresetKind(value: unknown): PresetKind | undefined {
    return value === "summary" || value === "insights" || value === "ask" ? value : undefined;
}

/** Full-segment positive integer — `parseInt` would accept `"1junk"` as 1. */
function parsePresetId(value: string): number | null {
    if (!/^[1-9]\d*$/.test(value)) {
        return null;
    }

    const id = Number(value);

    return Number.isSafeInteger(id) ? id : null;
}

function presetErrorResponse(error: unknown): { message: string; status: number } {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("not found")) {
        return { message, status: 404 };
    }

    if (message.includes("already have a")) {
        return { message, status: 409 };
    }

    if (message.includes("1000 characters") || message.includes("presets — delete")) {
        return { message, status: 422 };
    }

    return { message, status: 400 };
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
