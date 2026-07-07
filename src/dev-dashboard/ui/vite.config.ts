import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Relative on purpose: config bundlers inline relative imports but externalize bare ones.
import { env } from "../../utils/env.client";

const projectRoot = env.tools.getRoot() ?? process.cwd();
const appRoot = resolve(projectRoot, "src");
const { attachDevDashboardMiddleware } = await import(
    pathToFileURL(resolve(appRoot, "dev-dashboard/ui/vite-middleware.ts")).href
);
const { createPreviewIndexInjectMiddleware, createPreviewReloadSseMiddleware } = await import(
    pathToFileURL(resolve(appRoot, "utils/DashboardApp/preview/reload.ts")).href
);
const { createDashboardViteConfig } = await import(pathToFileURL(resolve(appRoot, "utils/ui/vite.base.ts")).href);
const { getConfig } = await import(pathToFileURL(resolve(appRoot, "dev-dashboard/config.ts")).href);
const dashboardConfig = await getConfig();

const config = createDashboardViteConfig({
    root: __dirname,
    port: 3042,
    aliases: {
        "@app": resolve(__dirname, "../.."),
        "@": resolve(__dirname, "src"),
    },
    reactOptions: {
        babel: {
            plugins: ["babel-plugin-react-compiler"],
        },
    },
    tanstackStartOptions: false,
    overrides: {
        build: {
            outDir: "dist",
            emptyOutDir: true,
            target: "es2022",
        },
        resolve: {
            dedupe: ["redux"],
        },
    },
});

const distDir = resolve(__dirname, "dist");

// Vite runs on a private port behind the Bun.serve front proxy. Tell the HMR
// client to connect to the public port so the proxy can bridge the HMR socket
// (Bun's node:http upgrade is broken; the proxy owns all WebSockets).
const publicPort = Number(env.dashboard.getPublicPort()) || 3042;

config.server = {
    ...config.server,
    ...(dashboardConfig.allowedHosts.length > 0 ? { allowedHosts: dashboardConfig.allowedHosts } : {}),
    hmr: { clientPort: publicPort },
};

config.plugins = [
    ...(config.plugins ?? []),
    {
        name: "dev-dashboard-middleware",
        configureServer(server) {
            attachDevDashboardMiddleware(server.middlewares);
        },
        configurePreviewServer(server) {
            attachDevDashboardMiddleware(server.middlewares);
            server.middlewares.use(createPreviewReloadSseMiddleware());
            server.middlewares.use(createPreviewIndexInjectMiddleware(distDir));
        },
    },
];

export default config;
