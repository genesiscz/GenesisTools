import { chmodSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import type { AIConfig } from "@app/utils/ai/AIConfig";
import type { AISecondaryLogin } from "@app/utils/config/ai.types";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { CLAUDE_CODE_CLIENT_ID, fetchOAuthProfile } from "./auth";

/**
 * Claude Code's keychain credential storage, mirrored from the 2.1.206 binary:
 * service "Claude Code-credentials" (unsuffixed for the default config dir),
 * account = $USER (validated), payload = JSON with a `claudeAiOauth` root key,
 * written hex-encoded via `security add-generic-password -U ... -X <hex>`.
 */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const VALID_KEYCHAIN_USER = /^[a-zA-Z0-9._-]+$/;

export interface ClaudeAiOauthCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    refreshTokenExpiresAt?: number | null;
    scopes: string[];
    subscriptionType?: string | null;
    rateLimitTier?: string | null;
    clientId?: string;
}

interface KeychainPayload {
    claudeAiOauth?: ClaudeAiOauthCredentials;
    [key: string]: unknown;
}

function keychainUser(): string {
    let user: string;
    try {
        user = process.env.USER || userInfo().username;
    } catch {
        user = "claude-code-user";
    }

    return VALID_KEYCHAIN_USER.test(user) ? user : "claude-code-user";
}

function assertMacOS(): void {
    if (process.platform !== "darwin") {
        throw new Error("Claude Code keychain injection is only supported on macOS.");
    }
}

/** Read the raw keychain payload Claude Code stores. Returns null when absent. */
export async function readKeychainPayload(): Promise<KeychainPayload | null> {
    assertMacOS();

    const proc = Bun.spawn({
        cmd: ["security", "find-generic-password", "-a", keychainUser(), "-w", "-s", KEYCHAIN_SERVICE],
        stdout: "pipe",
        stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !text.trim()) {
        logger.debug(`[keychain] no "${KEYCHAIN_SERVICE}" entry (exit ${exitCode})`);
        return null;
    }

    try {
        return SafeJSON.parse(text.trim(), { strict: true }) as KeychainPayload;
    } catch (err) {
        logger.warn({ err }, "[keychain] payload is not valid JSON");
        return null;
    }
}

/**
 * Write the payload the way Claude Code does (`security -i` stdin with the
 * hex-encoded password, argv fallback for oversized payloads). `-U` updates
 * an existing entry in place.
 */
export async function writeKeychainPayload(payload: KeychainPayload): Promise<void> {
    assertMacOS();

    const json = SafeJSON.stringify(payload);
    const hex = Buffer.from(json, "utf-8").toString("hex");
    const user = keychainUser();
    const stdinCommand = `add-generic-password -U -a "${user}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`;

    const proc = Bun.spawn({
        cmd: ["security", "-i"],
        stdin: new TextEncoder().encode(stdinCommand),
        stdout: "pipe",
        stderr: "pipe",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Keychain write failed (exit ${exitCode}): ${stderr.trim().slice(0, 300)}`);
    }

    logger.info("[keychain] wrote Claude Code credentials entry");
}

/** Delete Claude Code's credential entry. Returns false when it was absent. */
export async function deleteKeychainEntry(): Promise<boolean> {
    assertMacOS();

    const proc = Bun.spawn({
        cmd: ["security", "delete-generic-password", "-a", keychainUser(), "-s", KEYCHAIN_SERVICE],
        stdout: "ignore",
        stderr: "ignore",
    });
    const ok = (await proc.exited) === 0;
    logger.info(`[keychain] delete entry: ${ok ? "removed" : "not present"}`);
    return ok;
}

/** Build the keychain payload for an account's secondary login. */
export function secondaryToKeychainPayload(secondary: AISecondaryLogin): KeychainPayload {
    return {
        claudeAiOauth: {
            accessToken: secondary.accessToken,
            refreshToken: secondary.refreshToken,
            expiresAt: secondary.expiresAt ?? 0,
            scopes: secondary.scopes ?? [],
            subscriptionType: secondary.subscriptionType ?? null,
            rateLimitTier: secondary.rateLimitTier ?? null,
            clientId: CLAUDE_CODE_CLIENT_ID,
        },
    };
}

/**
 * Resolve WHOSE credentials the keychain currently holds. Profile fetch on the
 * access token is authoritative; ~/.claude.json oauthAccount is the offline
 * fallback (Claude Code rewrites it from the same profile endpoint).
 */
export async function resolveKeychainAccountUuid(oauth: ClaudeAiOauthCredentials): Promise<string | undefined> {
    const profile = await fetchOAuthProfile(oauth.accessToken);

    if (profile?.account?.uuid) {
        return profile.account.uuid;
    }

    try {
        const claudeJson = await Bun.file(join(homedir(), ".claude.json")).json();
        const uuid = claudeJson?.oauthAccount?.accountUuid;

        if (typeof uuid === "string" && uuid) {
            logger.debug("[keychain] identity via ~/.claude.json fallback (profile fetch failed)");
            return uuid;
        }
    } catch (err) {
        logger.debug({ err }, "[keychain] ~/.claude.json fallback failed");
    }

    return undefined;
}

export type KeychainSyncResult =
    | { status: "no-entry" }
    | { status: "no-identity" }
    | { status: "no-match"; uuid: string }
    | { status: "unchanged"; account: string; uuid: string }
    | { status: "synced"; account: string; uuid: string };

/**
 * Pull the keychain credentials back into the ONE config account whose
 * secondary.accountUuid matches. Never touches any other account; never
 * writes when the identity is unknown or unmatched (e.g. the user did
 * /login to a different account or /logout inside Claude Code directly).
 */
export async function syncKeychainToConfig(aiConfig: AIConfig): Promise<KeychainSyncResult> {
    const payload = await readKeychainPayload();
    const oauth = payload?.claudeAiOauth;

    if (!oauth?.accessToken || !oauth.refreshToken) {
        return { status: "no-entry" };
    }

    const uuid = await resolveKeychainAccountUuid(oauth);
    if (!uuid) {
        logger.warn("[keychain] cannot resolve keychain identity — skipping sync to avoid a wrong-account write");
        return { status: "no-identity" };
    }

    const account = aiConfig
        .getAccountsByProvider("anthropic-sub")
        .find((a) => a.secondary?.accountUuid && a.secondary.accountUuid === uuid);

    if (!account?.secondary) {
        logger.info(`[keychain] entry belongs to uuid ${uuid} — no configured secondary login matches, not syncing`);
        return { status: "no-match", uuid };
    }

    if (account.secondary.accessToken === oauth.accessToken && account.secondary.refreshToken === oauth.refreshToken) {
        return { status: "unchanged", account: account.name, uuid };
    }

    await aiConfig.updateAccount(account.name, {
        secondary: {
            ...account.secondary,
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
            scopes: oauth.scopes?.length ? oauth.scopes : account.secondary.scopes,
            subscriptionType: oauth.subscriptionType ?? account.secondary.subscriptionType,
            rateLimitTier: oauth.rateLimitTier ?? account.secondary.rateLimitTier,
        },
    });

    logger.info(`[keychain] synced rotated credentials to account "${account.name}" (uuid ${uuid})`);
    return { status: "synced", account: account.name, uuid };
}

/**
 * Back up a keychain payload we are about to overwrite (foreign logins the
 * user made directly in Claude Code). chmod 600 — same sensitivity as the
 * ai config. Returns the backup path.
 */
export async function backupKeychainPayload(payload: KeychainPayload): Promise<string> {
    const dir = join(env.tools.getHome() || homedir(), ".genesis-tools", "claude", "keychain-backups");
    const path = join(dir, `keychain-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await Bun.write(path, SafeJSON.stringify(payload, null, 2));
    chmodSync(path, 0o600);
    logger.info(`[keychain] backed up existing entry to ${path}`);
    return path;
}
