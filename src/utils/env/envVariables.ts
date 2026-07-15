import { homedir } from "node:os";
import { cwd } from "node:process";
import {
    createApiKeyAccessor,
    type EnvKey,
    getFirstEnvKey,
    getFirstValue,
    getRaw,
    getTrimmed,
    getWithDefault,
    has,
    isFlag,
    isNonEmpty,
    parseIntEnv,
} from "@app/utils/env/env-core";
import { restoreEnv, setEnv, snapshotEnv, unsetEnv, withEnvOverrides } from "@app/utils/env/env-testing";
import { env as envClient } from "@app/utils/env.client";

const XAI_API_KEYS = ["XAI_API_KEY", "X_AI_API_KEY"] as const;
// HuggingFace local inference accepts either name depending on the library version.
const HF_TOKEN_KEYS = ["HUGGINGFACE_TOKEN", "HF_TOKEN"] as const;
// GitHub CLI and apps disagree on the canonical name — never use `gh auth token` here.
const GITHUB_TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"] as const;
const EDITOR_KEYS = ["VISUAL", "EDITOR"] as const;
const LOCALE_PREFERENCE_KEYS = ["LC_TIME", "LANG", "LC_ALL"] as const;

function xaiApiKey(): string | undefined {
    return getFirstValue(XAI_API_KEYS);
}

function xaiApiEnvKey(): EnvKey | undefined {
    return getFirstEnvKey(XAI_API_KEYS);
}

export const env = {
    get: getRaw,
    getTrimmed,
    has,
    isNonEmpty,
    isFlag,
    getFirstValue: (keys: readonly EnvKey[]) => getFirstValue(keys),
    getFirstEnvKey: (keys: readonly EnvKey[]) => getFirstEnvKey(keys),

    /** Shallow copy of process.env for child spawn inheritance and debug dumps. */
    getProcessEnv: snapshotEnv,

    // ── Top-level shortcuts (most common) ──────────────────────────────────
    getXAIApiKey: xaiApiKey,
    getXAIApiEnvKey: xaiApiEnvKey,
    hasXAIApiKey: () => xaiApiKey() !== undefined,

    /** xAI API + Grok CLI paths */
    x: {
        getApiKey: xaiApiKey,
        getApiEnvKey: xaiApiEnvKey,
        hasApiKey: () => xaiApiKey() !== undefined,
        getManagementKey: () => getTrimmed("XAI_MANAGEMENT_KEY"),
        getManagementEnvKey: () => (isNonEmpty("XAI_MANAGEMENT_KEY") ? "XAI_MANAGEMENT_KEY" : undefined),
        getTeamId: () => getTrimmed("XAI_TEAM_ID"),
        getTeamIdEnvKey: () => (isNonEmpty("XAI_TEAM_ID") ? "XAI_TEAM_ID" : undefined),
        getCliChatProxyBaseUrl: () =>
            getWithDefault("GROK_CLI_CHAT_PROXY_BASE_URL", "https://cli-chat-proxy.grok.com/v1"),
        getManagementApiBaseUrl: () => getWithDefault("GROK_MANAGEMENT_API_BASE_URL", "https://management-api.x.ai/v1"),
    },

    grok: {
        getHome: () => getWithDefault("GROK_HOME", `${homedir()}/.grok`),
    },

    copilot: {
        getApiHome: () => getTrimmed("COPILOT_API_HOME"),
        getApiHomeEnvKey: () => (isNonEmpty("COPILOT_API_HOME") ? "COPILOT_API_HOME" : undefined),
    },

    github: {
        getToken: () => getFirstValue(GITHUB_TOKEN_KEYS),
        getTokenEnvKey: () => getFirstEnvKey(GITHUB_TOKEN_KEYS),
        hasToken: () => getFirstValue(GITHUB_TOKEN_KEYS) !== undefined,
        // Copilot CLI uses this name explicitly — separate from generic GITHUB_TOKEN.
        getCopilotToken: () => getTrimmed("COPILOT_GITHUB_TOKEN"),
        getCopilotTokenEnvKey: () => (isNonEmpty("COPILOT_GITHUB_TOKEN") ? "COPILOT_GITHUB_TOKEN" : undefined),
    },

    brave: createApiKeyAccessor(["BRAVE_API_KEY"]),

    google: {
        ...createApiKeyAccessor(["GOOGLE_API_KEY"]),
        getRateLimitMs: () => parseIntEnv("GOOGLE_RATE_LIMIT_MS", 0),
    },

    hf: createApiKeyAccessor(HF_TOKEN_KEYS),

    ai: {
        openai: createApiKeyAccessor(["OPENAI_API_KEY"]),
        groq: createApiKeyAccessor(["GROQ_API_KEY"]),
        openrouter: createApiKeyAccessor(["OPENROUTER_API_KEY"]),
        anthropic: createApiKeyAccessor(["ANTHROPIC_API_KEY"]),
        jina: createApiKeyAccessor(["JINA_AI_API_KEY"]),
        assemblyai: createApiKeyAccessor(["ASSEMBLYAI_API_KEY"]),
        deepgram: createApiKeyAccessor(["DEEPGRAM_API_KEY"]),
        gladia: createApiKeyAccessor(["GLADIA_API_KEY"]),
        xai: createApiKeyAccessor(XAI_API_KEYS),

        /** Dynamic lookup for ask ProviderConfig.envKey and similar. */
        getByEnvKey: (key: EnvKey) => getTrimmed(key),

        listConfiguredEnvKeys: (keys: readonly EnvKey[]) => keys.filter((key) => isNonEmpty(key)),
    },

    tools: {
        getHome: () => getTrimmed("GENESIS_TOOLS_HOME") ?? homedir(),
        getHomeEnvKey: () => (isNonEmpty("GENESIS_TOOLS_HOME") ? "GENESIS_TOOLS_HOME" : undefined),
        getPath: () => getTrimmed("GENESIS_TOOLS_PATH"),
        getRoot: () => getTrimmed("GENESIS_TOOLS_ROOT"),
        getCommands: () => getTrimmed("COMMANDS"),
        getMailEnvelopePath: () => getTrimmed("MAIL_ENVELOPE_PATH"),
        getQdrantPort: () => parseIntEnv("GENESIS_QDRANT_PORT", 16_335),
        getQdrantGrpcPort: () => parseIntEnv("GENESIS_QDRANT_GRPC_PORT", 16_336),
    },

    paths: {
        getHome: () => getTrimmed("HOME") ?? homedir(),
        getUserProfile: () => getTrimmed("USERPROFILE"),
        getShell: (fallback = "/bin/sh") => getWithDefault("SHELL", fallback),
        getHistfile: () => getTrimmed("HISTFILE"),
        getClarityProjectCwd: () => getTrimmed("CLARITY_PROJECT_CWD") ?? cwd(),
        getAppData: () => getTrimmed("APPDATA"),
    },

    device: {
        getUser: () => getTrimmed("USER"),
        isRoot: () => getRaw("USER") === "root",
        getTermProgram: () => getTrimmed("TERM_PROGRAM"),
        getCmuxBundleId: () => getTrimmed("CMUX_BUNDLE_ID"),
        getDarwinKitTimeoutMs: () => parseIntEnv("DARWINKIT_TIMEOUT_MS", 0),
    },

    editor: {
        get: () => getFirstValue(EDITOR_KEYS),
        getEnvKey: () => getFirstEnvKey(EDITOR_KEYS),
        getVisual: () => getTrimmed("VISUAL"),
        getEditor: () => getTrimmed("EDITOR"),
    },

    locale: {
        getLang: () => getTrimmed("LANG"),
        getLcAll: () => getTrimmed("LC_ALL"),
        getLcTime: () => getTrimmed("LC_TIME"),
        getLcCtype: () => getTrimmed("LC_CTYPE"),
        getPreferred: () => getFirstValue(LOCALE_PREFERENCE_KEYS),
        getTerminalKeys: () => ["LANG", "LC_ALL", "LC_CTYPE"] as const,
    },

    log: {
        isTrace: () => isFlag("LOG_TRACE"),
        isDebug: () => isFlag("LOG_DEBUG"),
        isSilent: () => isFlag("LOG_SILENT"),
        getConsoleLevel: () => getTrimmed("LOG_CONSOLE_LEVEL"),
        shouldIncludePid: () => isFlag("LOG_PID") || isFlag("DEBUG"),
        getDashboardPort: () => parseIntEnv("LOG_DASHBOARD_PORT", 7243),
        // Generic DEBUG flag used outside logging (azure-devops stack traces, mcp-tsc, etc.)
        isDebugEnabled: () => Boolean(getTrimmed("DEBUG")),
    },

    test: {
        shouldRunNetworkTests: () => isNonEmpty("RUN_NETWORK_TESTS"),
        shouldRunE2E: () => isNonEmpty("E2E"),
        shouldRunIntegration: () => isNonEmpty("INTEGRATION"),
        shouldSkipNetworkTests: () => isNonEmpty("SKIP_NETWORK_TESTS"),
        shouldRunLiveSmoke: () => isFlag("SHOPS_LIVE_SMOKE") || isFlag("RUN_LIVE_SMOKE"),
        shouldRunShopsLiveItesco: () => isFlag("SHOPS_LIVE_ITESCO"),
        getTestAudioFile: () => getTrimmed("TEST_AUDIO_FILE"),
        isOllamaTest: () => isNonEmpty("TEST_OLLAMA"),
        isTvNetTests: () => isNonEmpty("TV_NET_TESTS"),
    },

    // Client-safe domains are defined once in @app/utils/env.client and re-exposed here.
    dashboard: envClient.dashboard,

    workos: {
        getApiKey: () => getTrimmed("WORKOS_API_KEY"),
        getClientId: () => getTrimmed("WORKOS_CLIENT_ID"),
        getRedirectUri: () => getTrimmed("WORKOS_REDIRECT_URI"),
        getCookiePassword: () => getTrimmed("WORKOS_COOKIE_PASSWORD"),
    },

    jenkins: {
        getUrl: () => getWithDefault("JENKINS_URL", ""),
        getUser: () => getWithDefault("JENKINS_USER", ""),
        getToken: () => getWithDefault("JENKINS_TOKEN", ""),
    },

    shops: {
        getSecretKeyPath: () => getTrimmed("SHOPS_SECRET_KEY_PATH"),
        getAlbertPersistedQueryHashesJson: () => getTrimmed("ALBERT_PERSISTED_QUERY_HASHES_JSON"),
        isLiveSmoke: () => isFlag("SHOPS_LIVE_SMOKE"),
        isLiveItesco: () => isFlag("SHOPS_LIVE_ITESCO"),
    },

    tradingview: {
        getCookie: () => getTrimmed("TRADINGVIEW_COOKIE"),
        getSessionId: () => getTrimmed("TRADINGVIEW_SESSIONID"),
        getSessionIdSign: () => getTrimmed("TRADINGVIEW_SESSIONID_SIGN"),
        getUserId: () => getTrimmed("TRADINGVIEW_USER_ID"),
        getUsername: () => getTrimmed("TRADINGVIEW_USERNAME"),
    },

    task: {
        getConfigPath: () => getTrimmed("TASK_CONFIG_PATH"),
        isDetachedWorker: () => isFlag("TASK_RUN_WORKER"),
        getWorkerEnvKey: () => "TASK_RUN_WORKER" as const,
    },

    question: {
        getConfigPath: () => getTrimmed("QUESTION_CONFIG_PATH"),
        getLogBase: () => getTrimmed("QUESTION_LOG_BASE"),
    },

    boards: {
        /** Test/tooling override for the boards SQLite path (e.g. ":memory:"). */
        getDbPath: () => getTrimmed("BOARDS_DB_PATH"),
        /** Base URL of the dev-dashboard server for MCP/CLI clients. */
        getBaseUrl: () => getTrimmed("BOARDS_BASE_URL"),
        /** Listener lease TTL override in ms. */
        getListenerTtlMs: () => {
            const raw = getTrimmed("BOARDS_LISTENER_TTL_MS");
            const n = raw ? Number(raw) : Number.NaN;
            return Number.isFinite(n) && n > 0 ? n : undefined;
        },
    },

    ask: {
        getConversationsDir: () => getTrimmed("ASK_CONVERSATIONS_DIR"),
    },

    node: envClient.node,

    youtube: {
        ...envClient.youtube,
        /**
         * Optional per-user service key(s) for the YouTube API server. A
         * comma-separated list — one key per user. When unset the server stays
         * open (localhost development is unaffected).
         */
        getServiceKey: () => getTrimmed("YOUTUBE_SERVICE_KEY"),
        /**
         * Bind host for the YouTube API server. Defaults to loopback so a VPS
         * deploy is not publicly reachable except through the reverse proxy; set
         * `0.0.0.0` (or a LAN IP) to expose it directly.
         */
        getHost: () => getWithDefault("YOUTUBE_HOST", "127.0.0.1"),
    },

    db: envClient.db,

    stripe: {
        getSecretKey: () => getTrimmed("STRIPE_SECRET_KEY"),
        getWebhookSecret: () => getTrimmed("STRIPE_WEBHOOK_SECRET"),
        getPriceId: (packId: "pack-small" | "pack-medium" | "pack-large") => {
            const envKey =
                packId === "pack-small"
                    ? "STRIPE_PRICE_PACK_SMALL"
                    : packId === "pack-medium"
                      ? "STRIPE_PRICE_PACK_MEDIUM"
                      : "STRIPE_PRICE_PACK_LARGE";

            return getTrimmed(envKey);
        },
    },

    testing: {
        snapshot: snapshotEnv,
        restore: restoreEnv,
        set: setEnv,
        unset: unsetEnv,
        withOverrides: withEnvOverrides,
    },
} as const;

export type Env = typeof env;
