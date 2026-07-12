import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import type { AIConfig } from "@app/utils/ai/AIConfig";
import {
    backupKeychainPayload,
    deleteKeychainEntry,
    type KeychainSyncResult,
    readKeychainPayload,
    secondaryToKeychainPayload,
    syncKeychainToConfig,
    writeKeychainPayload,
} from "@app/utils/claude/keychain";
import type { AISecondaryLogin } from "@app/utils/config/ai.types";
import { SafeJSON } from "@app/utils/json";

const CLAUDE_JSON = join(homedir(), ".claude.json");

export interface KeychainSessionPrep {
    /** Set when the keychain held a login not tracked by any account's secondary. */
    foreignPayloadBackup?: string;
    /** Result of the pre-inject sync (crash-recovery of a prior session's rotation). */
    preSync: KeychainSyncResult;
}

export interface ForeignKeychainEntry {
    uuid?: string;
}

/**
 * Inspect the keychain BEFORE injecting. Returns the foreign entry when the
 * current credentials belong to nobody we track — the caller must get user
 * confirmation before proceeding (overwriting logs that login out).
 */
export async function inspectKeychainBeforeInject(aiConfig: AIConfig): Promise<{
    preSync: KeychainSyncResult;
    foreign: ForeignKeychainEntry | null;
}> {
    const preSync = await syncKeychainToConfig(aiConfig);

    if (preSync.status === "no-match") {
        return { preSync, foreign: { uuid: preSync.uuid } };
    }

    if (preSync.status === "no-identity") {
        return { preSync, foreign: {} };
    }

    return { preSync, foreign: null };
}

/**
 * Inject the account's secondary login into the keychain and seed
 * ~/.claude.json so Claude Code starts logged-in (it re-fetches the full
 * oauthAccount from /api/oauth/profile itself).
 */
export async function injectSecondaryLogin(
    secondary: AISecondaryLogin,
    backupForeign: boolean
): Promise<string | undefined> {
    let backupPath: string | undefined;

    if (backupForeign) {
        const existing = await readKeychainPayload();

        if (existing?.claudeAiOauth) {
            backupPath = await backupKeychainPayload(existing);
        }
    }

    await writeKeychainPayload(secondaryToKeychainPayload(secondary));
    await seedClaudeJson(secondary);
    return backupPath;
}

/**
 * After the Claude Code session ends: pull any rotation back into the right
 * account, then return the keychain to its pre-inject state — but ONLY if the
 * entry still belongs to the injected identity. A different identity means
 * the user logged in directly mid-session; that login must survive.
 */
export async function finishKeychainSession(
    aiConfig: AIConfig,
    injectedUuid: string | undefined,
    foreignBackupPath: string | undefined
): Promise<KeychainSyncResult> {
    const postSync = await syncKeychainToConfig(aiConfig);

    const currentUuid =
        postSync.status === "synced" || postSync.status === "unchanged" || postSync.status === "no-match"
            ? postSync.uuid
            : undefined;

    if (postSync.status === "no-entry") {
        // User ran /logout inside Claude Code — nothing to sync. Restore the
        // pre-existing login if we displaced one.
        if (foreignBackupPath) {
            await restoreBackup(foreignBackupPath);
        }

        return postSync;
    }

    if (!injectedUuid || !currentUuid || currentUuid !== injectedUuid) {
        logger.info(
            `[keychain] entry identity changed during session (now ${currentUuid ?? "unknown"}) — leaving keychain as-is`
        );
        return postSync;
    }

    // Entry is still our injected chain (already synced above). Put the
    // keychain back the way we found it.
    if (foreignBackupPath) {
        await restoreBackup(foreignBackupPath);
    } else {
        await deleteKeychainEntry();
    }

    return postSync;
}

async function restoreBackup(backupPath: string): Promise<void> {
    try {
        const payload = SafeJSON.parse(await Bun.file(backupPath).text(), { strict: true });
        await writeKeychainPayload(payload);
        logger.info(`[keychain] restored pre-session entry from ${backupPath}`);
    } catch (err) {
        logger.error({ err, backupPath }, "[keychain] restore failed — backup file kept");
    }
}

/**
 * Best-effort ~/.claude.json patch: skip onboarding and seed oauthAccount
 * identity so the TUI shows the right account immediately. Failures must
 * never block the launch.
 */
async function seedClaudeJson(secondary: AISecondaryLogin): Promise<void> {
    try {
        const file = Bun.file(CLAUDE_JSON);
        const config = (await file.exists())
            ? (SafeJSON.parse(await file.text(), { strict: true }) as Record<string, unknown>)
            : {};

        config.hasCompletedOnboarding = true;

        if (secondary.accountUuid) {
            const previous = (config.oauthAccount ?? {}) as Record<string, unknown>;
            config.oauthAccount = {
                ...previous,
                accountUuid: secondary.accountUuid,
                emailAddress: secondary.emailAddress,
                organizationUuid: secondary.organizationUuid,
            };
        }

        await Bun.write(CLAUDE_JSON, SafeJSON.stringify(config, null, 2));
        logger.debug({ path: CLAUDE_JSON }, "Seeded oauthAccount + onboarding for keychain launch");
    } catch (error) {
        logger.warn({ error, path: CLAUDE_JSON }, "Could not seed ~/.claude.json for keychain launch");
    }
}
