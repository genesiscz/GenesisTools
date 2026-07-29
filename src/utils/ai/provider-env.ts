/**
 * Provider API keys a background process has to be told about explicitly.
 *
 * launchd (and cron) start an agent with a bare environment — HOME, PATH and
 * whatever the plist itself declares. A key exported from ~/.zshrc is therefore
 * invisible to the daemon, and every provider lookup fails with
 * `Could not resolve provider="xai" model="…"` while the exact same command
 * works when run from a terminal. Callers that register a long-lived background
 * process snapshot the configured subset here and pass it into the plist.
 */
import { env } from "@genesiscz/utils/env";

export const PROVIDER_API_KEY_ENV_KEYS = [
    "XAI_API_KEY",
    "X_AI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "JINA_AI_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "GLADIA_API_KEY",
    "HUGGINGFACE_TOKEN",
    "HF_TOKEN",
] as const;

/**
 * The keys above that are actually set right now, with their values. Unset keys
 * are omitted rather than forwarded as empty strings, which some SDKs treat as
 * "configured" and then fail on at request time.
 */
export function collectConfiguredProviderEnv(): Record<string, string> {
    const configured: Record<string, string> = {};

    for (const key of env.ai.listConfiguredEnvKeys(PROVIDER_API_KEY_ENV_KEYS)) {
        const value = env.ai.getByEnvKey(key);

        if (value) {
            configured[key] = value;
        }
    }

    return configured;
}
