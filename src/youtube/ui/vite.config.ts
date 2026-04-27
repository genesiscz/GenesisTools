import { resolve } from "node:path";
import { createDashboardViteConfig } from "@app/utils/ui/vite.base";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { youtubeConfigPlugin } from "./vite.plugins/config-middleware";

const root = resolve(import.meta.dirname);
const port = parseInt(process.env.YOUTUBE_UI_PORT ?? "3072", 10);

export default createDashboardViteConfig({
    root,
    port,
    plugins: [
        tanstackRouter({ target: "react", routesDirectory: resolve(root, "routes"), generatedRouteTree: resolve(root, "routeTree.gen.ts") }),
        youtubeConfigPlugin(),
    ],
    aliases: { "@app": resolve(root, "../.."), "@app/yt": root },
    tanstackStartOptions: false,
    watchDirs: ["youtube"],
});
