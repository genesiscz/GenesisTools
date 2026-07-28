import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

const { log } = logger.scoped("instagram:session");

export interface SessionConfig {
    /**
     * Name of the env var holding the cookie. The cookie itself is deliberately
     * never written to config — it is a live credential to a real account, and
     * this mirrors the `tokens.apiKeyEnv` convention used by the AI accounts.
     */
    sessionIdEnv?: string;
}

export interface ResolvedSession {
    sessionId: string;
    /**
     * Instagram expects `x-csrftoken` to match the `csrftoken` cookie. Sending a
     * placeholder is a fingerprint mismatch, and the research found mismatched
     * headers trigger enforcement independently of request volume.
     */
    csrfToken?: string;
    /** Where it came from, for the `status` command and for debugging auth failures. */
    source: "flag" | "env";
    envKey?: string;
}

const storage = new Storage("instagram");

export async function readSessionConfig(): Promise<SessionConfig> {
    const config = await storage.getConfig<SessionConfig>();
    return config ?? {};
}

export async function writeSessionConfig(config: SessionConfig): Promise<void> {
    await storage.ensureDirs();
    await storage.setConfig(config);
    log.debug({ sessionIdEnv: config.sessionIdEnv }, "wrote instagram session config");
}

/**
 * Resolve the session cookie, or `undefined` when there is none.
 *
 * Returning `undefined` rather than throwing is deliberate: every anonymous
 * command must keep working with no session at all, so only the story path
 * turns a missing cookie into an error.
 */
export async function resolveSession(explicitCookie?: string): Promise<ResolvedSession | undefined> {
    if (explicitCookie) {
        log.debug("session resolved from --session-cookie flag");
        return {
            sessionId: stripCookiePrefix(explicitCookie),
            csrfToken: extractCookie(explicitCookie, "csrftoken"),
            source: "flag",
        };
    }

    const fromEnv = env.instagram.getSessionId();
    if (fromEnv) {
        const envKey = env.instagram.getSessionIdEnvKey();
        log.debug({ envKey }, "session resolved from environment");
        return {
            sessionId: stripCookiePrefix(fromEnv),
            csrfToken: extractCookie(fromEnv, "csrftoken") ?? env.instagram.getCsrfToken(),
            source: "env",
            envKey,
        };
    }

    const config = await readSessionConfig();
    if (config.sessionIdEnv) {
        const referenced = env.get(config.sessionIdEnv);

        if (referenced && referenced.trim().length > 0) {
            log.debug({ envKey: config.sessionIdEnv }, "session resolved via configured env reference");
            return {
                sessionId: stripCookiePrefix(referenced.trim()),
                csrfToken: extractCookie(referenced, "csrftoken") ?? env.instagram.getCsrfToken(),
                source: "env",
                envKey: config.sessionIdEnv,
            };
        }

        log.warn(
            { envKey: config.sessionIdEnv },
            "config references an env var for the session cookie but it is unset or empty"
        );
    }

    log.debug("no session cookie available — anonymous mode only");
    return undefined;
}

/** Accepts a bare value or a pasted `sessionid=...` pair, since browsers copy the latter. */
function stripCookiePrefix(value: string): string {
    const trimmed = value.trim().replace(/;$/, "");
    const match = trimmed.match(/(?:^|;\s*)sessionid=([^;]+)/);
    return match ? match[1] : trimmed;
}

/** Pull one named cookie out of a pasted `a=1; b=2` cookie string. */
function extractCookie(value: string, name: string): string | undefined {
    const match = value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? match[1].trim() : undefined;
}

export const __testing = { stripCookiePrefix, extractCookie };
