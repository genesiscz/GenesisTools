import { logger } from "@app/logger";
import { Storage } from "@app/utils/storage";
import type { TvSession } from "./types";

const TV_ORIGIN = "https://www.tradingview.com";

interface SessionOpts {
    cookie?: string;
    username?: string;
    userId?: number;
}

function cookieFromParts(): string | undefined {
    const sid = process.env.TRADINGVIEW_SESSIONID;
    const sign = process.env.TRADINGVIEW_SESSIONID_SIGN;
    if (sid && sign) {
        return `sessionid=${sid}; sessionid_sign=${sign}`;
    }
    return undefined;
}

export async function resolveSession(opts: SessionOpts = {}): Promise<TvSession | null> {
    const cookie = opts.cookie ?? process.env.TRADINGVIEW_COOKIE ?? cookieFromParts();
    if (cookie) {
        const username = opts.username ?? process.env.TRADINGVIEW_USERNAME ?? "";
        const userId = opts.userId ?? Number(process.env.TRADINGVIEW_USER_ID ?? 0);
        const session: TvSession = { username, userId, cookie };
        if (!username || !userId) {
            const enriched = await enrichFromHomepage(session);
            if (enriched) {
                return enriched;
            }
        }
        return session;
    }

    const storage = new Storage("tradingview");
    const stored = await storage.getConfigValue<TvSession>("session");
    if (stored?.cookie) {
        return stored;
    }
    logger.debug("tradingview: no session cookie found in flags, env, or config");
    return null;
}

export async function saveSession(session: TvSession): Promise<void> {
    const storage = new Storage("tradingview");
    await storage.setConfigValue("session", session);
}

async function enrichFromHomepage(session: TvSession): Promise<TvSession | null> {
    try {
        const res = await fetch(`${TV_ORIGIN}/`, {
            headers: { cookie: session.cookie, origin: TV_ORIGIN },
        });
        const html = await res.text();
        const uname = html.match(/"username":"([^"]+)"/);
        const uid = html.match(/"id":(\d+),"username"/) ?? html.match(/"user_id":(\d+)/);
        return {
            ...session,
            username: session.username || (uname ? uname[1] : ""),
            userId: session.userId || (uid ? Number(uid[1]) : 0),
        };
    } catch (err) {
        logger.debug({ err }, "tradingview: failed to enrich session from homepage");
        return null;
    }
}

export async function fetchAuthToken(cookie: string): Promise<string> {
    const res = await fetch(`${TV_ORIGIN}/`, {
        headers: { cookie, origin: TV_ORIGIN },
    });
    const html = await res.text();
    const m = html.match(/"auth_token":"([^"]+)"/);
    if (!m) {
        logger.debug("tradingview: auth_token not found in homepage, falling back to guest");
        return "unauthorized_user_token";
    }
    return m[1];
}
