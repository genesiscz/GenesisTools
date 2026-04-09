import { resolve } from "node:path";
import { createDashboardViteConfig } from "../../../../utils/ui/vite.base";

export default createDashboardViteConfig({
    root: __dirname,
    port: 3072,
    aliases: {
        "@app": resolve(__dirname, "../../../.."),
    },
});
