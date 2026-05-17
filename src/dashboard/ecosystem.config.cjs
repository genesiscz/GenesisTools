// PM2 process config for the self-hosted dashboard.
//
// FORK MODE + instances:1 IS MANDATORY. The app keeps per-process state that
// cluster mode would shard incorrectly:
//   - the in-memory SSE event bus (lib/events/event-bus.server.ts)
//   - the single better-sqlite3 writer (WAL readers, one writer)
// Multiple workers => clients miss events emitted on another worker and
// sqlite write contention rises. Horizontal scaling is NOT supported with
// the current SQLite + in-memory-bus architecture.
//
// Start: pm2 start ecosystem.config.cjs --env production && pm2 save

module.exports = {
    apps: [
        {
            name: "dashboard-web",
            // Built by `turbo run build --filter=@dashboard/web` (vite build → Nitro).
            script: "apps/web/.output/server/index.mjs",
            cwd: "/opt/dashboard/src/dashboard",
            exec_mode: "fork",
            instances: 1,
            time: true,
            max_memory_restart: "512M",
            // SIGTERM handler drains ~3s before closing sqlite; give PM2 reload
            // headroom past its 1.6s default before it SIGKILLs.
            kill_timeout: 8000,
            env_production: {
                NODE_ENV: "production",
                PORT: "3000",
                // ABSOLUTE paths — see SQLITE_PATH hazard in drizzle/index.ts.
                SQLITE_PATH: "/opt/dashboard/data/dashboard.sqlite",
                MIGRATIONS_DIR: "/opt/dashboard/src/dashboard/apps/web/src/drizzle/migrations",
                // Fill from your secrets store / .env.production (never commit real values).
                WORKOS_API_KEY: "",
                WORKOS_CLIENT_ID: "",
                WORKOS_REDIRECT_URI: "https://your.domain/auth/callback",
                WORKOS_COOKIE_PASSWORD: "",
                ANTHROPIC_API_KEY: "",
                // Optional: both must be set to enable the /mcp endpoint
                // (else /mcp returns 501). MCP_BEARER_TOKEN must be >= 16 chars.
                MCP_BEARER_TOKEN: "",
                MCP_USER_ID: "",
            },
            error_file: "/var/log/dashboard/web-error.log",
            out_file: "/var/log/dashboard/web-out.log",
        },
    ],
};
