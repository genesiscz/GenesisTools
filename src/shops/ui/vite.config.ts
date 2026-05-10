import { resolve } from "node:path";
import { createDashboardViteConfig } from "@app/utils/ui/vite.base";

export default createDashboardViteConfig({
    root: __dirname,
    port: 3072,
    aliases: {
        "@app": resolve(__dirname, "../.."),
    },
    watchDirs: ["shops"],
    tanstackStartOptions: {
        srcDirectory: ".",
    },
});
