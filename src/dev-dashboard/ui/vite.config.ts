import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.env.GENESIS_TOOLS_ROOT ?? process.cwd();
const appRoot = resolve(projectRoot, "src");
const { attachDevDashboardMiddleware } = await import(
    pathToFileURL(resolve(appRoot, "dev-dashboard/ui/vite-middleware.ts")).href
);
const { createDashboardViteConfig } = await import(pathToFileURL(resolve(appRoot, "utils/ui/vite.base.ts")).href);

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
});

config.server = {
    ...config.server,
    allowedHosts: ["mac.foltyn.dev"],
};

config.plugins = [
    ...(config.plugins ?? []),
    {
        name: "dev-dashboard-middleware",
        configureServer(server) {
            attachDevDashboardMiddleware(server.middlewares);
        },
    },
];

export default config;
