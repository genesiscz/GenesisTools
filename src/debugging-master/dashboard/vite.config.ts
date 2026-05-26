import { resolve } from "node:path";
import { mergeConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { createDashboardViteConfig } from "../../utils/ui/vite.base";

const apiPort = process.env.LOG_DASHBOARD_PORT ?? "7243";
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default mergeConfig(
    createDashboardViteConfig({
        root: __dirname,
        port: 7244,
        plugins: [
            viteTsConfigPaths({
                projects: ["./tsconfig.json"],
            }),
        ],
        aliases: {
            "@app": resolve(__dirname, "..", ".."),
        },
        tanstackStartOptions: false,
        overrides: {
            base: "/",
            build: {
                outDir: "dist",
                emptyOutDir: true,
                target: "es2022",
                assetsDir: "assets",
            },
        },
    }),
    {
        server: {
            proxy: {
                "/api": { target: apiTarget, changeOrigin: true },
                "/log": { target: apiTarget, changeOrigin: true },
                "/health": { target: apiTarget, changeOrigin: true },
            },
        },
    }
);
