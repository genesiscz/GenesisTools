import type { spawnAppServer } from "./app-server-client";

export const ACCOUNT_ENV_UNSET = [
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CHATGPT_BASE_URL",
    "CODEX_CHATGPT_BASE_URL",
];

export function buildAccountLaunchOptions(options: {
    sharedHome: string;
    accountName: string;
    cwd: string;
}): Parameters<typeof spawnAppServer>[0] {
    return {
        cwd: options.cwd,
        home: options.sharedHome,
        envOverrides: { TOOLS_CODEX_ACCOUNT: options.accountName },
        unsetEnv: ACCOUNT_ENV_UNSET,
        config: ['cli_auth_credentials_store="ephemeral"', 'forced_login_method="chatgpt"', 'model_provider="openai"'],
    };
}
