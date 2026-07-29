import { randomBytes } from "node:crypto";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { withRequestContext } from "@app/youtube/lib/request-context";
import type { YtUser } from "@app/youtube/lib/users.types";
import { logger } from "@genesiscz/utils/logger";

/**
 * Fixed identity for work the console starts: CLI commands, MCP tools, and any
 * other non-browser caller. It is a real `users` row, because every audit sink
 * keys on `user_id` — `ai_calls.user_id`, `job_activity` via the job's owner,
 * and the ownership filter on `ask_sessions`. Service-key auth deliberately
 * does NOT map to a user (`lib/server/auth.ts`), so it cannot be used here.
 */
export const CONSOLE_USER_EMAIL = "console@genesis.local";

/**
 * Standing balance for the console account.
 *
 * `reserveCredits` has no role- or flag-based waiver anywhere in the codebase,
 * so "don't bill the console" is expressed as a balance large enough never to
 * run out rather than as a bypass. Console paths mostly avoid credit-gated
 * routes entirely; this only matters when one is reused.
 */
export const CONSOLE_CREDIT_GRANT = 1_000_000;

/** Password login is impossible for this account: the hash is random and never recorded. */
function unusablePasswordHash(): Promise<string> {
    return Bun.password.hash(randomBytes(32).toString("hex"), "argon2id");
}

/**
 * Returns the console service user, creating it on first use. Idempotent and
 * safe to call on every command.
 */
export async function getOrCreateConsoleUser(db: YoutubeDatabase): Promise<YtUser> {
    const existing = readConsoleUser(db);

    if (existing) {
        return existing;
    }

    const passwordHash = await unusablePasswordHash();
    // The `ytu_` prefix is mandatory: every auth path that resolves a user from a
    // token checks it (`USER_TOKEN_PREFIX` in `lib/server/auth.ts`), so a token
    // without it would be invisible to `resolveUser`/`requireUser`.
    const apiToken = `ytu_${randomBytes(32).toString("hex")}`;

    try {
        const created = db.transaction(() => {
            const user = db.createUser({ email: CONSOLE_USER_EMAIL, passwordHash, apiToken });
            const credits = db.grantCredits(user.id, CONSOLE_CREDIT_GRANT, "service-grant");

            return { ...user, credits };
        });
        logger.info({ userId: created.id, email: CONSOLE_USER_EMAIL }, "youtube: console service account created");

        return created;
    } catch (err) {
        // Two first-use callers (a CLI command and the server, or two commands) can
        // both read no row before either inserts — `users.email` is UNIQUE, so the
        // loser's insert fails and its credit grant rolls back with it. The winner's
        // row is the console user; adopt it instead of failing the command.
        const winner = readConsoleUser(db);

        if (!winner) {
            throw err;
        }

        logger.debug({ err, userId: winner.id }, "youtube: console service account already created concurrently");

        return winner;
    }
}

function readConsoleUser(db: YoutubeDatabase): YtUser | null {
    const row = db.getUserByEmail(CONSOLE_USER_EMAIL);

    if (!row) {
        return null;
    }

    const { passwordHash: _hash, apiToken: _token, ...user } = row;

    return user;
}

/**
 * Runs `fn` attributed to the console user.
 *
 * `recordYoutubeUsage` writes to `ai_calls` only when an ambient job or request
 * context supplies a db handle (`lib/usage.ts` logs "no db in context (CLI
 * path)" otherwise). Wrapping console work in the same request-context ALS the
 * HTTP server uses is what makes CLI and MCP calls land in the audit trail with
 * a real owner, instead of vanishing.
 */
export async function withConsoleContext<T>(db: YoutubeDatabase, fn: (user: YtUser) => Promise<T>): Promise<T> {
    const user = await getOrCreateConsoleUser(db);

    return withRequestContext({ db, userId: user.id }, () => fn(user));
}
