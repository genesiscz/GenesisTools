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

export function defaultApiKeyEnvName(account: AiProxyAccountConfig): string {
    if (account.apiKeyEnv) {
        return account.apiKeyEnv;
    }

    return account.provider === "openai" ? "OPENAI_API_KEY" : "XAI_API_KEY";
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
    const pattern = new RegExp(`^\\s*(export\\s+)?${envName}\\s*=`, "m");

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
