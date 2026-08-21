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
} from "@genesiscz/utils/env/env-core";
import { restoreEnv, setEnv, snapshotEnv, unsetEnv, withEnvOverrides } from "@genesiscz/utils/env/env-testing";
import { env as envClient } from "@genesiscz/utils/env.client";

const XAI_API_KEYS = ["XAI_API_KEY", "X_AI_API_KEY"] as const;
// HuggingFace local inference accepts either name depending on the library version.
const HF_TOKEN_KEYS = ["HUGGINGFACE_TOKEN", "HF_TOKEN"] as const;
// GitHub CLI and apps disagree on the canonical name — never use `gh auth token` here.
const GITHUB_TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"] as const;
// Instaloader and instagrapi both use IG_SESSIONID; INSTAGRAM_SESSIONID reads clearer.
const INSTAGRAM_SESSION_KEYS = ["IG_SESSIONID", "INSTAGRAM_SESSIONID"] as const;
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

    aiProxy: {
        /** Save the last failing WHAM request/response (redacted, no tokens) under ~/.genesis-tools/ai-proxy/debug/. */
        getDebugCapture: () => isFlag("AI_PROXY_DEBUG_CAPTURE"),
        /**
         * Save every exchange's full prompt + response under
         * ~/.genesis-tools/ai-proxy/transcripts/. On by default (this is a local
         * proxy and the transcripts are the only post-hoc debugging evidence);
         * set AI_PROXY_TRANSCRIPTS=0 to turn it off.
         *
         * Unlike the debug capture above, transcripts are NOT redacted: whatever
         * a prompt carried (file contents, keys pasted into a message, tool
         * arguments) lands on disk verbatim. The directory is created 0700 and
         * the files 0600, so this stays readable only by the running user.
         */
        getTranscripts: () => {
            const raw = getTrimmed("AI_PROXY_TRANSCRIPTS")?.toLowerCase();
            return raw !== "0" && raw !== "false" && raw !== "off";
        },
        /**
         * Which grok upstream serves Anthropic /v1/messages requests.
         * "responses" (default) translates to the /responses wire, which names
         * every parallel tool call; "shim" is the instant fallback to the
         * native /v1/messages passthrough with the routing-tag repair.
         */
        getGrokMessagesRoute: (): "responses" | "shim" =>
            getTrimmed("AI_PROXY_GROK_MESSAGES_ROUTE")?.toLowerCase() === "shim" ? "shim" : "responses",
    },

    github: {
        getToken: () => getFirstValue(GITHUB_TOKEN_KEYS),
        getTokenEnvKey: () => getFirstEnvKey(GITHUB_TOKEN_KEYS),
        hasToken: () => getFirstValue(GITHUB_TOKEN_KEYS) !== undefined,
        // Copilot CLI uses this name explicitly — separate from generic GITHUB_TOKEN.
        getCopilotToken: () => getTrimmed("COPILOT_GITHUB_TOKEN"),
        getCopilotTokenEnvKey: () => (isNonEmpty("COPILOT_GITHUB_TOKEN") ? "COPILOT_GITHUB_TOKEN" : undefined),
    },

    instagram: {
        // Session cookie for the story/highlight endpoints. Instagram gates story
        // media on viewer identity, so the anonymous surface (profile, posts,
        // highlight ids) needs none of this and must keep working without it.
        getSessionId: () => getFirstValue(INSTAGRAM_SESSION_KEYS),
        getSessionIdEnvKey: () => getFirstEnvKey(INSTAGRAM_SESSION_KEYS),
        hasSessionId: () => getFirstValue(INSTAGRAM_SESSION_KEYS) !== undefined,
        // Instagram expects x-csrftoken to match the csrftoken cookie sitting next
        // to sessionid — a mismatch is a fingerprint signal, so fetch both.
        getCsrfToken: () => getTrimmed("IG_CSRFTOKEN"),
    },

    security: {
        // Base64 of the vault's 32-byte master key. The headless rung: launchd
        // daemons started before login and SSH sessions cannot reach the login
        // keychain, so they carry the key in the environment instead.
        getMasterKey: () => getTrimmed("GENESIS_TOOLS_MASTER_KEY"),
        getMasterKeyEnvKey: () => "GENESIS_TOOLS_MASTER_KEY" as const,
    },

    brave: createApiKeyAccessor(["BRAVE_API_KEY"]),

    google: {
        // GOOGLE_GENERATIVE_AI_API_KEY is what the bare @ai-sdk/google singleton
        // read on its own. It was therefore invisible to this facade and to every
        // config-based audit — and would have stopped working the moment the
        // singleton path went away. Naming it here keeps it alive and visible.
        ...createApiKeyAccessor(["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]),
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
        // NOTE: this FALLS BACK to homedir(), so it is never undefined. Asking it
        // "is a sandbox configured?" always answers yes — that bug let worktree
        // builds migrate the user's real config. Use hasExplicitHome() for that
        // question.
        getHome: () => getTrimmed("GENESIS_TOOLS_HOME") ?? homedir(),
        /** True only when GENESIS_TOOLS_HOME is actually set (a sandboxed root). */
        hasExplicitHome: () => isNonEmpty("GENESIS_TOOLS_HOME"),
        /**
         * Opt out of the worktree migration guard for the deliberate post-merge
         * run. Read through the facade so `env.testing` overrides are seen; a
         * direct `process.env` read in the guard was invisible to them.
         */
        allowsRealMigration: () => getTrimmed("GENESIS_TOOLS_ALLOW_REAL_MIGRATION") === "1",
        getHomeEnvKey: () => (isNonEmpty("GENESIS_TOOLS_HOME") ? "GENESIS_TOOLS_HOME" : undefined),
        getPath: () => getTrimmed("GENESIS_TOOLS_PATH"),
        getRoot: () => getTrimmed("GENESIS_TOOLS_ROOT"),
        getCommands: () => getTrimmed("COMMANDS"),
        getMailEnvelopePath: () => getTrimmed("MAIL_ENVELOPE_PATH"),
        getQdrantPort: () => parseIntEnv("GENESIS_QDRANT_PORT", 16_335),
        getQdrantGrpcPort: () => parseIntEnv("GENESIS_QDRANT_GRPC_PORT", 16_336),
        /** Comma-delimited capability filter for `tools claude mcp` (e.g. "question_answer,boards"). */
        getMcpCapabilities: (): string[] | undefined => {
            const raw = getTrimmed("GENESIS_TOOLS_MCP_CAPABILITIES");
            if (raw === undefined) {
                return undefined;
            }

            const capabilities = raw
                .split(",")
                .map((c) => c.trim().toLowerCase())
                .filter((c) => c.length > 0);

            return capabilities.length > 0 ? capabilities : undefined;
        },
    },

    paths: {
        getHome: () => getTrimmed("HOME") ?? homedir(),
        getUserProfile: () => getTrimmed("USERPROFILE"),
        getShell: (fallback = "/bin/sh") => getWithDefault("SHELL", fallback),
        /** Claude Code's config dir override; when set, `.claude.json` lives at `<dir>/.claude.json`. */
        getClaudeConfigDir: () => getTrimmed("CLAUDE_CONFIG_DIR"),
        getHistfile: () => getTrimmed("HISTFILE"),
        getClarityProjectCwd: () => getTrimmed("CLARITY_PROJECT_CWD") ?? cwd(),
        getAppData: () => getTrimmed("APPDATA"),
        /** Where `tools learn-from-fable bootstrap` proposes to put the pack repo. */
        getFablePackPath: () => getTrimmed("GT_FABLE_PACK_PATH"),
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
        /**
         * Opt a test process OUT of the throwaway `~/.genesis-tools` sandbox that
         * `preload-test-sandbox` installs. Nothing in the suite should need it.
         */
        allowsRealHome: () => isFlag("GENESIS_TOOLS_TEST_ALLOW_REAL_HOME"),
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
        /**
         * Enables the dev-only Stripe stand-in top-up endpoint
         * (POST /api/v1/users/topup). Off by default so a deployed server
         * never mints credits outside real billing; set to `1` locally.
         */
        isDevTopupAllowed: () => isFlag("YOUTUBE_ALLOW_DEV_TOPUP"),
    },

    spotify: {
        ...envClient.spotify,
        /** Override the profile registry path (tests point this at a temp dir). */
        getConfigPath: () => getTrimmed("SPOTIFY_CONFIG_PATH"),
        /** Override the parsed-history cache directory. */
        getCacheDir: () => getTrimmed("SPOTIFY_CACHE_DIR"),
        /** Default profile when no `--profile` is passed. */
        getProfile: () => getTrimmed("SPOTIFY_PROFILE"),
        /** Last.fm API key; without it the enricher scrapes the public tag page. */
        getLastfmApiKey: () => getTrimmed("LASTFM_API_KEY"),
        /** Where a first run looks for `streaming-history/` and `data/` before ~/Documents. */
        getExportDir: () => getTrimmed("SPOTIFY_EXPORT_DIR"),
        /** CDP endpoint of the logged-in browser `play run` drives (default http://127.0.0.1:9222). */
        getBrowserUrl: () => getTrimmed("SPOTIFY_BROWSER_URL"),
    },

    db: envClient.db,

    // Generic Stripe accessors only — which env var maps to which product/price
    // is domain-specific and lives with the caller (e.g. youtube's billing.ts).
    stripe: {
        getSecretKey: () => getTrimmed("STRIPE_SECRET_KEY"),
        getWebhookSecret: () => getTrimmed("STRIPE_WEBHOOK_SECRET"),
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
