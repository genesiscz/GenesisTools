import { chmodSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import type { AISecondaryLogin } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { CLAUDE_CODE_CLIENT_ID, fetchOAuthProfile } from "./auth";

/**
 * Claude Code's keychain credential storage, mirrored from the 2.1.206 binary:
 * service "Claude Code-credentials" (unsuffixed for the default config dir),
 * account = $USER (validated), payload = JSON with a `claudeAiOauth` root key,
 * written hex-encoded via `security add-generic-password -U ... -X <hex>`.
 */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const VALID_KEYCHAIN_USER = /^[a-zA-Z0-9._-]+$/;
/** `security` exits with the low byte of the OSStatus: 44 is errSecItemNotFound, the one exit that means "absent". */
const SECURITY_ITEM_NOT_FOUND = 44;

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

/** What the keychain holds: nothing, a payload, or an entry that exists but could not be read. */
export type KeychainEntryRead =
    | { state: "absent" }
    | { state: "ok"; payload: KeychainPayload }
    | { state: "unreadable"; reason: string };

export interface SecurityCliResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** A write refused because the entry it would replace exists but could not be read. */
export class KeychainUnreadableError extends Error {
    constructor(reason: string) {
        super(
            `Claude Code's keychain login exists but cannot be read (${reason}). It was left untouched. ` +
                "Unlock the login keychain, or allow access when macOS asks, then run the command again."
        );
        this.name = "KeychainUnreadableError";
    }
}

/**
 * The one door to the `security` CLI. Claude Code's login item is machine-global: a test that reached it
 * would read, or overwrite, the user's real login. So the real door refuses under `bun test` (RUN_KEYCHAIN=1
 * opts in), and tests replace `run` with a fake that records every call.
 */
export const claudeKeychainCli = {
    async run(args: string[], stdin?: string): Promise<SecurityCliResult> {
        if (isTestProcess() && !env.isFlag("RUN_KEYCHAIN")) {
            throw new Error(
                "The security CLI is blocked under bun test: Claude Code's keychain login is machine-global. " +
                    "Fake claudeKeychainCli.run instead."
            );
        }

        const proc = Bun.spawn({
            cmd: ["security", ...args],
            stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        return { exitCode, stdout, stderr };
    },
};

function keychainUser(): string {
    let user: string;
    try {
        user = env.device.getUser() || userInfo().username;
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

/**
 * The keychain owner's account uuid read from the offline marker Claude Code
 * keeps in ~/.claude.json. Cheaper and quieter than the keychain itself (no
 * `security` invocation), and enough to ATTRIBUTE a login. Callers that need
 * authority over latency should prefer readKeychainPayload plus
 * resolveKeychainAccountUuid and fall back to this.
 */
export async function keychainOwnerUuidOffline(): Promise<string | undefined> {
    try {
        const file = Bun.file(join(homedir(), ".claude.json"));

        if (!(await file.exists())) {
            return undefined;
        }

        const config = SafeJSON.parse(await file.text(), { strict: true }) as {
            oauthAccount?: { accountUuid?: string };
        };

        return config.oauthAccount?.accountUuid;
    } catch (err) {
        logger.debug({ err }, "[keychain] offline owner marker unreadable");
        return undefined;
    }
}

/**
 * Read Claude Code's keychain entry, keeping "there is none" apart from "there is one we cannot read". Only
 * errSecItemNotFound (or an empty password, which holds nothing) is absent. Any other exit (a locked
 * keychain, a denied access prompt) or a payload that is not a JSON object is unreadable, and a write must
 * then refuse: it would replace a login it could neither back up nor identify.
 */
export async function readKeychainEntry(): Promise<KeychainEntryRead> {
    // No keychain off macOS (a Linux devbox, CI): that is "no ambient
    // identity", not an error. Status, the rotated-creds sync and the doctor
    // degrade gracefully; pinned sessions via CLAUDE_CODE_OAUTH_TOKEN are the
    // model there. The WRITE paths stay macOS-only.
    if (process.platform !== "darwin") {
        logger.debug("[keychain] no keychain on this platform — no ambient identity");
        return { state: "absent" };
    }

    const result = await claudeKeychainCli.run([
        "find-generic-password",
        "-a",
        keychainUser(),
        "-w",
        "-s",
        KEYCHAIN_SERVICE,
    ]);

    if (result.exitCode === SECURITY_ITEM_NOT_FOUND) {
        logger.debug(`[keychain] no "${KEYCHAIN_SERVICE}" entry`);
        return { state: "absent" };
    }

    if (result.exitCode !== 0) {
        const detail = result.stderr.trim().slice(0, 300) || "no message";
        return { state: "unreadable", reason: `security exited ${result.exitCode}: ${detail}` };
    }

    const text = result.stdout.trim();

    if (!text) {
        logger.debug(`[keychain] "${KEYCHAIN_SERVICE}" entry is empty`);
        return { state: "absent" };
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(text, { strict: true });
    } catch (err) {
        return { state: "unreadable", reason: `the payload is not valid JSON (${String(err)})` };
    }

    if (!isJsonObject(parsed)) {
        return { state: "unreadable", reason: "the payload is not a JSON object" };
    }

    return { state: "ok", payload: parsed as KeychainPayload };
}

/**
 * The raw payload Claude Code stores, or null when there is none. An unreadable entry is null here too,
 * with a warning: callers of this one only report. A path that writes the keychain decides on
 * {@link readKeychainEntry}, and {@link writeKeychainPayload} checks it again itself.
 */
export async function readKeychainPayload(): Promise<KeychainPayload | null> {
    const entry = await readKeychainEntry();

    if (entry.state === "unreadable") {
        logger.warn(`[keychain] "${KEYCHAIN_SERVICE}" entry is unreadable (${entry.reason})`);
        return null;
    }

    return entry.state === "ok" ? entry.payload : null;
}

/**
 * Write the payload the way Claude Code does (`security -i` stdin with the
 * hex-encoded password, argv fallback for oversized payloads). `-U` updates
 * an existing entry in place.
 *
 * Refuses (KeychainUnreadableError) when the entry it would replace exists but cannot be read. The check
 * sits here, right before the overwrite, so a caller that never thought to look is covered too.
 */
export async function writeKeychainPayload(payload: KeychainPayload): Promise<void> {
    assertMacOS();

    const current = await readKeychainEntry();

    if (current.state === "unreadable") {
        throw new KeychainUnreadableError(current.reason);
    }

    const json = SafeJSON.stringify(payload);
    const hex = Buffer.from(json, "utf-8").toString("hex");
    const user = keychainUser();
    const stdinCommand = `add-generic-password -U -a "${user}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`;

    const result = await claudeKeychainCli.run(["-i"], stdinCommand);

    if (result.exitCode !== 0) {
        throw new Error(`Keychain write failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`);
    }

    logger.info("[keychain] wrote Claude Code credentials entry");
}

/** Delete Claude Code's credential entry. Returns false when it was absent. */
export async function deleteKeychainEntry(): Promise<boolean> {
    assertMacOS();

    const result = await claudeKeychainCli.run([
        "delete-generic-password",
        "-a",
        keychainUser(),
        "-s",
        KEYCHAIN_SERVICE,
    ]);
    const ok = result.exitCode === 0;
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
        const claudeJson = SafeJSON.parse(await Bun.file(join(homedir(), ".claude.json")).text(), { strict: true });
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
    | { status: "unreadable"; reason: string }
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
    const entry = await readKeychainEntry();

    if (entry.state === "unreadable") {
        logger.warn(`[keychain] entry is unreadable (${entry.reason}) — not syncing, and nothing may overwrite it`);
        return { status: "unreadable", reason: entry.reason };
    }

    const oauth = entry.state === "ok" ? entry.payload.claudeAiOauth : undefined;

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
    const dir = join(env.tools.getHome(), ".genesis-tools", "claude", "keychain-backups");
    const path = join(dir, `keychain-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await Bun.write(path, SafeJSON.stringify(payload, null, 2));
    chmodSync(path, 0o600);
    logger.info(`[keychain] backed up existing entry to ${path}`);
    return path;
}
