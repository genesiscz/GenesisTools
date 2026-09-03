import { resolve } from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
// Relative on purpose: config bundlers inline relative imports but externalize bare ones.
import { SafeJSON } from "../../utils/json";
import { DASHBOARDS, WEB_SERVICES } from "../../utils/ui/dashboards";
import { createDashboardViteConfig } from "../../utils/ui/vite.base";

const root = resolve(import.meta.dirname);
const repoRoot = resolve(root, "../../..");
const port = DASHBOARDS.monitor.port;
const apiTarget = `http://127.0.0.1:${WEB_SERVICES["monitor-server"].port}`;

export default createDashboardViteConfig({
    root,
    port,
    host: "127.0.0.1",
    plugins: [
        tanstackRouter({
            target: "react",
            routesDirectory: resolve(root, "routes"),
            generatedRouteTree: resolve(root, "routeTree.gen.ts"),
        }),
    ],
    aliases: { "@app": resolve(root, "../..") },
    tanstackStartOptions: false,
    overrides: {
        // The WebSocket goes straight to the monitor server: Vite 8 never
        // completes the upgrade through `proxy.ws`, so the browser would sit on
        // "polling" forever. HTTP still goes through the proxy below.
        define: { __MONITOR_API_ORIGIN__: SafeJSON.stringify(apiTarget, { strict: true }) },
        // `server` replaces the base object wholesale, so repeat the base fields.
        server: {
            port,
            host: "127.0.0.1",
            strictPort: true,
            fs: { allow: [root, repoRoot] },
            watch: { ignored: ["**/routeTree.gen.ts"] },
            // Same-origin API in dev: the UI always talks to /api/v1/… and the
            // built bundle is served by the monitor server itself.
            // Regex on purpose: a bare "/api" prefix would also swallow
            // /api.hooks.ts and /api.client.ts, which Vite serves from this dir.
            proxy: {
                "^/api/": { target: apiTarget, changeOrigin: false, ws: true },
            },
        },
    },
});
