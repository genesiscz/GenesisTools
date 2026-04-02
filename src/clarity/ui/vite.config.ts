import { resolve } from "node:path";
import { createDashboardViteConfig } from "../../utils/ui/vite.base";

export default createDashboardViteConfig({
    root: __dirname,
    port: 3071,
    aliases: {
        "@app": resolve(__dirname, "../.."),
    },
    watchDirs: ["azure-devops"],
});
