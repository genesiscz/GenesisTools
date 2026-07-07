/**
 * Client-safe env facade (@app/utils/env.client).
 *
 * Unlike @app/utils/env this module pulls in no node builtins (no node:os /
 * node:process) and no bare-specifier imports, which makes it safe to:
 *  - value-import from browser/client trees (env-core falls back to
 *    import.meta.env when `process` is absent — VITE_-prefixed vars only);
 *  - import RELATIVELY from vite.config.ts / drizzle.config.ts. Config
 *    bundlers inline relative imports but externalize bare ones, so a bare
 *    "@app/utils/env" import is unresolvable at config-load time in isolated
 *    workspaces (this exact failure kept src/dashboard/apps/web from booting).
 *
 * Server-only accessors (API keys, homedir-based paths, process-env
 * snapshots) intentionally stay in @app/utils/env.
 */

// Relative on purpose — keeps the whole module inlinable by config bundlers.
import { getRaw, getTrimmed, getWithDefault, has, isFlag, isNonEmpty, parseIntEnv } from "./env/env-core";

export type { EnvKey } from "./env/env-core";

export const env = {
    get: getRaw,
    getTrimmed,
    has,
    isNonEmpty,
    isFlag,

    node: {
        getEnv: () => getTrimmed("NODE_ENV"),
        isProduction: () => getRaw("NODE_ENV") === "production",
        getPort: (fallback?: string) => getTrimmed("PORT") ?? fallback,
    },

    dashboard: {
        getBindHost: (fallback = "0.0.0.0") => getWithDefault("DASHBOARD_BIND_HOST", fallback),
        shouldOpenBrowser: () => isFlag("DASHBOARD_OPEN_BROWSER"),
        isDevtoolsEnabled: () => isFlag("DASHBOARD_DEVTOOLS"),
        getQaBaseUrl: () => getWithDefault("DD_QA_BASE_URL", "http://localhost:3042"),
        getPublicPort: () => getTrimmed("DEV_DASHBOARD_PUBLIC_PORT"),
        getDiskDuTimeoutMs: () => parseIntEnv("DD_DISK_DU_TIMEOUT_MS", 0),
    },

    db: {
        getSqlitePath: (fallback = ".data/dashboard.sqlite") => getWithDefault("SQLITE_PATH", fallback),
        getMigrationsDir: () => getTrimmed("MIGRATIONS_DIR"),
    },

    tools: {
        getRoot: () => getTrimmed("GENESIS_TOOLS_ROOT"),
    },

    youtube: {
        getGitSha: () => getTrimmed("YOUTUBE_GIT_SHA"),
        getUiPort: () => getTrimmed("YOUTUBE_UI_PORT"),
    },
} as const;

export type EnvClient = typeof env;
