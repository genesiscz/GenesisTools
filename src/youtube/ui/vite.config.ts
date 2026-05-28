import { resolve } from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { DASHBOARDS } from "../../utils/ui/dashboards";
import { createDashboardViteConfig } from "../../utils/ui/vite.base";
import { youtubeConfigPlugin } from "./vite.plugins/config-middleware";

const root = resolve(import.meta.dirname);
const port = parseInt(process.env.YOUTUBE_UI_PORT ?? String(DASHBOARDS.youtube.port), 10);

export default createDashboardViteConfig({
    root,
    port,
    plugins: [
        tanstackRouter({
            target: "react",
            routesDirectory: resolve(root, "routes"),
            generatedRouteTree: resolve(root, "routeTree.gen.ts"),
        }),
        youtubeConfigPlugin(),
    ],
    aliases: { "@app/yt": root, "@app": resolve(root, "../..") },
    tanstackStartOptions: false,
    watchDirs: ["youtube"],
});
