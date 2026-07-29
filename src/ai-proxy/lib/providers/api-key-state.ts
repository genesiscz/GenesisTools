/**
 * Where an api-key account currently stands, for the CLI to show before it asks
 * the user to change anything.
 *
 * The three states come straight from the two config fields the guard reads
 * (`apiKey`, `allowEnvApiKey`), so what the CLI prints and what the proxy will
 * actually do cannot drift apart.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

export type ApiKeyState =
    /** A key is stored on the account; the environment is ignored. */
    | "override"
    /** No stored key, but the account may spend the environment's key. */
    | "env"
    /** No stored key and no opt-in: the account has no usable credential. */
    | "none";

export interface ApiKeyStatus {
    state: ApiKeyState;
    /** Env var the account would read, whether or not it is set. */
    envName: string;
    /** Whether that variable is present in this process's environment. */
    envPresent: boolean;
    /** Masked form of the stored key, if any. Never the value. */
    maskedOverride?: string;
}

/**
 * The env var to NAME in guards, errors and status output.
 *
 * Alias-aware on purpose: xAI resolves through `XAI_API_KEY` or the legacy
 * `X_AI_API_KEY`, so an account relying on the alias must be told the variable
 * that was actually read. Every site that reports an env var goes through here,
 * or the name in the message disagrees with the key that was resolved.
 */
export function defaultApiKeyEnvName(account: AiProxyAccountConfig): string {
    if (account.apiKeyEnv) {
        return account.apiKeyEnv;
    }

    if (account.provider === "openai") {
        return "OPENAI_API_KEY";
    }

    return env.x.getApiEnvKey() ?? "XAI_API_KEY";
}

export function maskApiKey(key: string): string {
    if (key.length <= 8) {
        return "****";
    }

    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function apiKeyStatus(account: AiProxyAccountConfig): ApiKeyStatus {
    const envName = defaultApiKeyEnvName(account);
    const stored = account.apiKey?.trim();

    return {
        state: stored ? "override" : account.allowEnvApiKey ? "env" : "none",
        envName,
        envPresent: Boolean(env.ai.getByEnvKey(envName)),
        maskedOverride: stored ? maskApiKey(stored) : undefined,
    };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SHELL_RC_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile"];

async function shellConfigCandidates(): Promise<string[]> {
    const home = homedir();
    const candidates = SHELL_RC_FILES.map((file) => join(home, file));
    const shellDir = join(home, ".config", "shell");

    try {
        for (const entry of await readdir(shellDir)) {
            candidates.push(join(shellDir, entry));
        }
    } catch (err) {
        logger.debug({ err, shellDir }, "ai-proxy: no ~/.config/shell directory to scan");
    }

    return candidates;
}

/**
 * Best-effort answer to "where does this env var come from?" — returns the FILE
 * that exports it, never the value, and undefined when it cannot be found (the
 * variable may come from a keychain helper, a launch agent, or a parent shell).
 */
export async function findEnvSourceFile(envName: string): Promise<string | undefined> {
    // `envName` is a config value (`apiKeyEnv`), so it reaches here unvalidated:
    // unescaped, a `(` would throw SyntaxError out of an interactive prompt and
    // a `.` would match a variable the account does not actually read.
    const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(envName)}\\s*=`, "m");

    for (const file of await shellConfigCandidates()) {
        try {
            if (pattern.test(await readFile(file, "utf-8"))) {
                return file;
            }
        } catch (err) {
            logger.debug({ err, file }, "ai-proxy: shell config candidate unreadable");
        }
    }

    return undefined;
}
