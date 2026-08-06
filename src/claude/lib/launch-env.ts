import { homedir } from "node:os";
import { join } from "node:path";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * The env a token-pinned Claude Code process needs. Shared by `start`, `exec`
 * and the agent-team teammate wrapper so a fix to the Fable escape hatches
 * reaches all three.
 *
 * The /model *catalog* comes from /api/claude_cli/bootstrap, which 403s for
 * inference-only setup tokens ("scope requirement user:profile"), so Fable
 * never loads. The two ANTHROPIC_* model vars are Claude Code's escape hatches:
 *  1. ANTHROPIC_DEFAULT_FABLE_MODEL opens the Fable availability gate (vYe()),
 *     so `/model fable` and Fable inference are allowed. It does NOT add Fable
 *     to the picker list for first-party OAuth (Xf()/firstParty stays empty).
 *  2. ANTHROPIC_CUSTOM_MODEL_OPTION pushes an entry straight into the picker
 *     list, ungated by first-party, so "Fable 5" shows up in `/model` without
 *     the user typing it. `[1m]` selects the 1M-context Fable.
 */
export const FABLE_MODEL_ID = "claude-fable-5";
export const FABLE_MODEL_OPTION = "claude-fable-5[1m]";
export const FABLE_MODEL_OPTION_NAME = "Fable 5";
export const FABLE_MODEL_OPTION_DESCRIPTION = "Fable 5 · Most capable for hardest and longest-running tasks";

/**
 * Claude Code reads `.claude.json` from `$CLAUDE_CONFIG_DIR/.claude.json` when that
 * env var is set (else `~/.claude.json`). The onboarding patch must target the same
 * file the launched claude will read, or it silently patches the wrong config.
 */
function claudeJsonPath(): string {
    return join(env.paths.getClaudeConfigDir() ?? homedir(), ".claude.json");
}

/**
 * Claude Code's interactive onboarding ignores CLAUDE_CODE_OAUTH_TOKEN and shows
 * the OAuth login screen when hasCompletedOnboarding is false (e.g. after /logout).
 * See anthropics/claude-code#8938, #46259 — token auth works once onboarding is skipped.
 */
export async function ensureOnboardingSkippedForOAuthToken(): Promise<void> {
    // Best-effort by contract: any fs/parse failure here (permissions, disk, foreign
    // ~/.claude.json) must log and return — never abort the actual claude launch.
    const claudeJson = claudeJsonPath();

    try {
        const file = Bun.file(claudeJson);
        const text = (await file.exists()) ? await file.text() : "{}";

        if (/"hasCompletedOnboarding"\s*:\s*true/.test(text)) {
            return;
        }

        let updated: string;

        if (/"hasCompletedOnboarding"\s*:\s*false/.test(text)) {
            updated = text.replace(/"hasCompletedOnboarding"\s*:\s*false/, '"hasCompletedOnboarding": true');
        } else {
            const config = SafeJSON.parse(text, { strict: true }) as Record<string, unknown>;
            config.hasCompletedOnboarding = true;
            updated = SafeJSON.stringify(config, null, 2);
        }

        await Bun.write(claudeJson, updated);
        logger.debug({ path: claudeJson }, "Set hasCompletedOnboarding for CLAUDE_CODE_OAUTH_TOKEN launch");
    } catch (error) {
        logger.warn({ error, path: claudeJson }, "Could not patch hasCompletedOnboarding");
    }
}

/** The plan word Claude Code expects in CLAUDE_CODE_SUBSCRIPTION_TYPE ("max", "pro"). */
export function subscriptionTypeOf(account: Pick<AIAccountEntry, "label">): string {
    return account.label?.split(" ")[0] ?? "max";
}

export function pinnedLaunchEnv(
    account: Pick<AIAccountEntry, "name" | "label">,
    longLivedToken: string
): Record<string, string> {
    return {
        TOOLS_CLAUDE_ACCOUNT: account.name,
        CLAUDE_CODE_OAUTH_TOKEN: longLivedToken,
        // Interactive CC can't resolve the tier from an inference-only setup token,
        // which blocks opus/sonnet [1m] model switches (see claude-code#70124).
        CLAUDE_CODE_SUBSCRIPTION_TYPE: subscriptionTypeOf(account),
        ANTHROPIC_DEFAULT_FABLE_MODEL: FABLE_MODEL_ID,
        ANTHROPIC_CUSTOM_MODEL_OPTION: FABLE_MODEL_OPTION,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: FABLE_MODEL_OPTION_NAME,
        ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: FABLE_MODEL_OPTION_DESCRIPTION,
    };
}
