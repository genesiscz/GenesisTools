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
// apps/server (the separate Nitro app on :4000) is intentionally NOT run in
// production — apps/web never dials it and websocket is disabled. Do not add
// it here.
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
            },
            error_file: "/var/log/dashboard/web-error.log",
            out_file: "/var/log/dashboard/web-out.log",
        },
    ],
};
