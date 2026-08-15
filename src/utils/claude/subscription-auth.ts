import { appendFileSync, chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retry } from "@genesiscz/utils/async";
import { env } from "@genesiscz/utils/env";
import { parseJSON, SafeJSON } from "@genesiscz/utils/json";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { logger } from "@genesiscz/utils/logger";
import type { OAuthTokens } from "./auth";
import { claudeOAuth } from "./auth";

export interface SubscriptionAccount {
    name: string;
    label?: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
}

export interface ResolveOptions {
    /** Force refresh even if the token appears valid (e.g., after 429) */
    forceRefresh?: boolean;
    /**
     * The access token the caller currently holds. Used to detect whether
     * another process already refreshed (avoids double-refresh of single-use tokens).
     * Falls back to the on-disk token when omitted.
     */
    staleAccessToken?: string;
    /** Lock timeout in ms. Default: 60_000 */
    lockTimeout?: number;
    /**
     * Diagnosis mode: read the stored token, never rotate it.
     *
     * A refresh token is single-use, and the rotated pair only survives if the
     * config write lands. A worktree build has that write guarded, so a probe
     * that "just checks" an expired account would consume the grant and be
     * unable to persist its replacement, bricking the account silently. Refresh
     * belongs to real use; `doctor` sets this and reports instead.
     */
    noRefresh?: boolean;
}

export interface ResolvedToken {
    token: string;
    account: SubscriptionAccount;
    refreshed: boolean;
}

/**
 * Returns true for errors where the refresh request provably never reached
 * token issuance, so retrying the SAME refresh token is safe: 5xx responses
 * and connection-refused. Ambiguous failures (ECONNRESET, ETIMEDOUT, socket
 * hang up) are NOT retried — the server may have already rotated the
 * single-use refresh token before the connection died, and re-sending the
 * consumed token is a reuse signal that can revoke the whole grant family.
 * The next poll retries naturally if the token was never consumed.
 */
function isTransientRefreshError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    if (/\b5\d{2}\b/.test(msg)) {
        return true;
    }

    if (/ECONNREFUSED/i.test(msg)) {
        return true;
    }

    return false;
}

/**
 * Per-account cooldown after invalid_grant. A dead refresh token stays dead
 * until re-login; without this every poll re-hammers the token endpoint with
 * a known-dead token (~1 POST/30s per consumer).
 *
 * Persisted, NOT a module-level Map: the usage poll daemon is a fresh process
 * every minute, so an in-memory cooldown never survives to the run it was
 * meant to stop. Two dead-grant accounts sent ~1,082 refresh POSTs each on
 * 2026-08-08 with the in-memory version in place. A re-login is still picked
 * up immediately — a fresh access token returns on the fast path above,
 * before this cooldown is ever consulted.
 */
const INVALID_GRANT_COOLDOWN_MS = 10 * 60 * 1000;

function invalidGrantPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "ai", "invalid-grant.json");
}

function readInvalidGrants(): Record<string, number> {
    try {
        return parseJSON<Record<string, number>>(readFileSync(invalidGrantPath(), "utf8")) ?? {};
    } catch (err) {
        // "No cooldowns yet" is the normal state, not a problem worth a line.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            logger.debug({ err }, "[token-refresh] invalid_grant cooldown file unreadable");
        }

        return {};
    }
}

function invalidGrantSince(account: string): number | undefined {
    return readInvalidGrants()[account];
}

/**
 * Read-modify-write the cooldown file under its own lock, writing atomically.
 *
 * Both halves matter and neither is theoretical. Usage polling runs as a fresh
 * process per minute while `tools claude login` / `config` clear cooldowns from
 * another terminal, so an unlocked read-modify-write drops one of two concurrent
 * updates. And a reader that catches a HALF-WRITTEN file falls back to `{}`,
 * which reads as "no cooldown" and re-hammers the token endpoint the cooldown
 * exists to protect.
 */
async function mutateInvalidGrants(
    account: string,
    mutate: (all: Record<string, number>) => boolean
): Promise<void> {
    const path = invalidGrantPath();

    try {
        await withFileLock(`${path}.lock`, async () => {
            const all = readInvalidGrants();

            if (!mutate(all)) {
                return;
            }

            atomicWriteFileSync(path, SafeJSON.stringify(all, null, 2) ?? "{}", { mode: 0o600 });
        });
    } catch (err) {
        logger.warn({ err, account }, "[token-refresh] could not update invalid_grant cooldown");
    }
}

async function markInvalidGrant(account: string): Promise<void> {
    await mutateInvalidGrants(account, (all) => {
        all[account] = Date.now();
        return true;
    });
}

/** Drop the cooldown after a successful refresh or a re-login. */
export async function clearInvalidGrant(account: string): Promise<void> {
    await mutateInvalidGrants(account, (all) => {
        if (!(account in all)) {
            return false;
        }

        delete all[account];
        return true;
    });
}

/**
 * Append the old and freshly-issued token pair to a journal BEFORE the config
 * write. Refresh tokens are single-use: if the process dies (or the write is
 * lost) between Anthropic issuing the new pair and the config save, the new
 * pair exists nowhere else and the account is bricked until re-login. The
 * journal makes that window recoverable. Same sensitivity as config.json
 * (plaintext tokens), so chmod 600. Failures never block the refresh itself.
 */
function journalTokenRotation(account: string, oldTokens: Partial<OAuthTokens>, newTokens: OAuthTokens): void {
    try {
        const path = journalPath();
        appendFileSync(
            path,
            `${SafeJSON.stringify({
                ts: new Date().toISOString(),
                account,
                oldAccessToken: oldTokens.accessToken,
                oldRefreshToken: oldTokens.refreshToken,
                newAccessToken: newTokens.accessToken,
                newRefreshToken: newTokens.refreshToken,
                newExpiresAt: newTokens.expiresAt,
            })}\n`,
            { mode: 0o600 }
        );

        chmodSync(path, 0o600);
        pruneJournal(path);
    } catch (err) {
        logger.warn({ err, account }, "[token-refresh] journal append failed");
    }
}

const JOURNAL_MAX_BYTES = 1_000_000;
const JOURNAL_KEEP_DAYS = 30;

/**
 * Keep the journal bounded without weakening it.
 *
 * The token VALUES have to stay readable: this file is the last resort when a
 * config write is lost mid-rotation, and `readJournalRecovery` reuses the pair
 * verbatim. Redacting or encrypting it would trade a real recovery path for
 * cosmetic hygiene, and the master key may be exactly what is unavailable in
 * that situation. So instead of touching entries, drop the old ones: anything
 * older than the retention window can no longer be the live pair.
 */
/**
 * Newest-first until the budget runs out, then stop.
 *
 * Age alone does not bound the file: a burst of rotations inside the retention
 * window keeps every line, and the journal grows without limit. Recovery only
 * ever reuses the most recent pair for an account, so dropping from the old end
 * is the cut that costs nothing. At least one line always survives, even if that
 * single line is bigger than the whole budget.
 */
function keepNewestWithinBudget(lines: string[], maxBytes: number): string[] {
    const kept: string[] = [];
    let bytes = 0;

    for (let i = lines.length - 1; i >= 0; i--) {
        bytes += Buffer.byteLength(lines[i], "utf8") + 1;

        if (bytes > maxBytes && kept.length > 0) {
            break;
        }

        kept.push(lines[i]);
    }

    return kept.reverse();
}

/** Exported for its test: the byte bound has no other observable seam. */
export function pruneJournal(path: string): void {
    try {
        if (!existsSync(path) || statSync(path).size < JOURNAL_MAX_BYTES) {
            return;
        }

        const cutoff = Date.now() - JOURNAL_KEEP_DAYS * 24 * 60 * 60 * 1000;
        const kept = readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => {
                if (!line.trim()) {
                    return false;
                }

                try {
                    const entry = SafeJSON.parse(line, { strict: true }) as { ts?: string };
                    return entry.ts ? Date.parse(entry.ts) >= cutoff : true;
                } catch {
                    // An unparsable line is corruption, not a token pair worth keeping.
                    return false;
                }
            });

        const bounded = keepNewestWithinBudget(kept, JOURNAL_MAX_BYTES);

        writeFileSync(path, bounded.length > 0 ? `${bounded.join("\n")}\n` : "", { mode: 0o600 });
        chmodSync(path, 0o600);
        logger.info(
            { path, kept: bounded.length, droppedByBudget: kept.length - bounded.length },
            "[token-refresh] pruned token journal"
        );
    } catch (err) {
        logger.warn({ err, path }, "[token-refresh] journal prune failed");
    }
}

function journalPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "ai", "token-journal.jsonl");
}

/**
 * When a refresh dies with invalid_grant, the config's refresh token may be a
 * stale, already-consumed one that a concurrent writer reverted (this bricked
 * an account for 3 days on 2026-07-24 — the journal held the live pair the
 * whole time). Returns the newest journaled pair for the account IF its
 * refresh token differs from the one that just failed; one recovery attempt
 * with it is safe because a journaled-but-unpersisted token was never sent to
 * the server again.
 */
export function readJournalRecovery(
    account: string,
    consumedRefreshToken: string
): { accessToken: string; refreshToken: string; expiresAt: number } | null {
    let raw: string;
    try {
        raw = readFileSync(journalPath(), "utf8");
    } catch (err) {
        logger.debug({ err, account }, "[token-refresh] journal unreadable, no recovery candidate");
        return null;
    }

    const lines = raw.trim().split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseJSON<{
            account?: string;
            newAccessToken?: string;
            newRefreshToken?: string;
            newExpiresAt?: number;
        }>(lines[i]);

        if (!entry || entry.account !== account) {
            continue;
        }

        if (!entry.newRefreshToken || entry.newRefreshToken === consumedRefreshToken) {
            return null;
        }

        return {
            accessToken: entry.newAccessToken ?? "",
            refreshToken: entry.newRefreshToken,
            expiresAt: entry.newExpiresAt ?? 0,
        };
    }

    return null;
}

/**
 * List all Anthropic subscription accounts from unified AI config.
 * Returns empty array if no accounts configured.
 */
export async function listAvailableAccounts(): Promise<SubscriptionAccount[]> {
    const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");
    const config = await AIConfig.load();
    return config.getAccountsByProvider("anthropic-sub").map((acc) => ({
        name: acc.name,
        label: acc.label,
        accessToken: acc.tokens.accessToken ?? "",
        refreshToken: acc.tokens.refreshToken,
        expiresAt: acc.tokens.expiresAt,
    }));
}

/**
 * Resolve a valid access token for the given account (or default account).
 * Refreshes expired tokens automatically with retry on transient errors.
 *
 * Guarantees:
 * - Acquires config file lock before any mutation
 * - Re-reads config from disk inside lock (prevents TOCTOU)
 * - Detects if another process already refreshed (prevents double-refresh of single-use tokens)
 * - Retries only errors where the single-use refresh token provably wasn't
 *   consumed (5xx, ECONNREFUSED) up to 2 times with 1s fixed delay
 * - Detects invalid_grant, applies a per-account cooldown, and provides an
 *   actionable error message
 * - Persists new tokens to disk immediately after refresh, before returning
 */
export async function resolveAccountToken(accountName?: string, options?: ResolveOptions): Promise<ResolvedToken> {
    const forceRefresh = options?.forceRefresh ?? false;
    const lockTimeout = options?.lockTimeout ?? 60_000;

    const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");
    const aiConfig = await AIConfig.load();
    const name = accountName ?? aiConfig.getDefaultAccount("ask")?.name;

    const acc = name ? aiConfig.getAccount(name) : undefined;

    if (!name || !acc) {
        throw new Error(
            accountName
                ? `Account "${accountName}" not found in AI config`
                : "No default account configured. Run `tools claude login` first."
        );
    }

    const staleAccessToken = options?.staleAccessToken ?? acc.tokens.accessToken;

    // Fast path: token is valid and no force-refresh requested
    if (!forceRefresh && acc.tokens.expiresAt && !claudeOAuth.needsRefresh(acc.tokens.expiresAt)) {
        return {
            token: acc.tokens.accessToken ?? "",
            account: {
                name,
                label: acc.label,
                accessToken: acc.tokens.accessToken ?? "",
                refreshToken: acc.tokens.refreshToken,
                expiresAt: acc.tokens.expiresAt,
            },
            refreshed: false,
        };
    }

    // Diagnosis stops here, BEFORE the lock and before anything is logged as an
    // initiated refresh: past this line the single-use grant is spent.
    if (options?.noRefresh) {
        const reason = acc.tokens.expiresAt
            ? `expired ${new Date(acc.tokens.expiresAt).toISOString()}`
            : "has no recorded expiry";
        throw new Error(
            `Access token for "${name}" ${reason} and refresh is disabled for diagnosis ` +
                `(a refresh token is single-use, so a probe must not spend it). Run: tools claude login ${name}`
        );
    }

    const caller = forceRefresh ? "force-refresh" : "token-expired";
    logger.info(`[token-refresh] ${name}: initiating refresh (reason: ${caller})`);

    // Slow path: acquire lock, re-read from disk, refresh
    const refreshed = await aiConfig.withLock(async (data) => {
        const diskAccount = data.accounts.find((a) => a.name === name);

        if (!diskAccount) {
            throw new Error(`Account "${name}" not found in config`);
        }

        // Check if another process already refreshed
        if (diskAccount.tokens.expiresAt && !claudeOAuth.needsRefresh(diskAccount.tokens.expiresAt)) {
            if (!forceRefresh || diskAccount.tokens.accessToken !== staleAccessToken) {
                logger.info(
                    `[token-refresh] ${name}: skipped — another process already refreshed ` +
                        `(expires ${new Date(diskAccount.tokens.expiresAt).toISOString()})`
                );
                return diskAccount;
            }
        }

        if (!diskAccount.tokens.refreshToken) {
            logger.warn(`[token-refresh] ${name}: no refresh token available`);
            return null;
        }

        // Cooldown is checked here — after the disk re-read — not before the lock: if another
        // process re-logged in, the fresh-token detection above already returned the new token.
        // Only a refresh token that is still dead on disk hits the cooldown, so a re-login is
        // picked up immediately instead of being blocked for the full window.
        const lastInvalidGrant = invalidGrantSince(name);

        if (lastInvalidGrant && Date.now() - lastInvalidGrant < INVALID_GRANT_COOLDOWN_MS) {
            throw new Error(`Token expired (invalid_grant). Run: tools claude login ${name}`);
        }

        // Refresh with retry on transient errors (5xx, network)
        let newTokens: OAuthTokens;
        try {
            newTokens = await retry(() => claudeOAuth.refresh(diskAccount.tokens.refreshToken!), {
                maxAttempts: 3,
                delay: 1000,
                backoff: "fixed",
                shouldRetry: isTransientRefreshError,
                onRetry: (attempt, retryDelay) => {
                    logger.warn(`[token-refresh] ${name}: retry ${attempt}/2 after ${retryDelay}ms`);
                },
            });
        } catch (err) {
            if (String(err).includes("invalid_grant")) {
                // The consumed token may be a stale revert of a journaled rotation —
                // try the journal's newest pair once before declaring the grant dead.
                const recovery = readJournalRecovery(name, diskAccount.tokens.refreshToken);

                if (recovery) {
                    logger.warn(
                        `[token-refresh] ${name}: invalid_grant on stored token, ` +
                            `attempting recovery with newer journaled refresh token`
                    );
                    try {
                        newTokens = await claudeOAuth.refresh(recovery.refreshToken);
                        logger.info(`[token-refresh] ${name}: journal recovery succeeded`);
                    } catch (recoveryErr) {
                        await markInvalidGrant(name);
                        logger.warn(
                            `[token-refresh] ${name}: journal recovery failed: ` +
                                `${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`
                        );
                        throw new Error(`Token expired (invalid_grant). Run: tools claude login ${name}`);
                    }
                } else {
                    await markInvalidGrant(name);
                    throw new Error(`Token expired (invalid_grant). Run: tools claude login ${name}`);
                }
            } else {
                throw new Error(
                    `Failed to refresh token for "${name}": ${err instanceof Error ? err.message : err}. ` +
                        `Run \`tools claude login ${name}\` if this persists.`
                );
            }
        }

        journalTokenRotation(name, diskAccount.tokens, newTokens);

        // Persist by mutating data in place — withLock handles save automatically
        const idx = data.accounts.findIndex((a) => a.name === name);
        data.accounts[idx] = {
            ...diskAccount,
            tokens: {
                ...diskAccount.tokens,
                accessToken: newTokens.accessToken,
                refreshToken: newTokens.refreshToken,
                expiresAt: newTokens.expiresAt,
                refreshExpiresAt: newTokens.refreshExpiresAt ?? diskAccount.tokens.refreshExpiresAt,
            },
        };

        await clearInvalidGrant(name);
        logger.info(
            `[token-refresh] ${name}: refreshed successfully ` +
                `(new expires ${new Date(newTokens.expiresAt).toISOString()})`
        );

        return data.accounts[idx];
    }, lockTimeout);

    // No refresh token available — if the token is expired, fail clearly
    if (!refreshed) {
        if (acc.tokens.expiresAt && claudeOAuth.needsRefresh(acc.tokens.expiresAt)) {
            throw new Error(
                `Token for "${name}" is expired and no refresh token is available. ` + `Run: tools claude login ${name}`
            );
        }

        return {
            token: acc.tokens.accessToken ?? "",
            account: {
                name,
                label: acc.label,
                accessToken: acc.tokens.accessToken ?? "",
                refreshToken: acc.tokens.refreshToken,
                expiresAt: acc.tokens.expiresAt,
            },
            refreshed: false,
        };
    }

    return {
        token: refreshed.tokens.accessToken ?? "",
        account: {
            name,
            label: refreshed.label ?? acc.label,
            accessToken: refreshed.tokens.accessToken ?? "",
            refreshToken: refreshed.tokens.refreshToken,
            expiresAt: refreshed.tokens.expiresAt,
        },
        refreshed: true,
    };
}
