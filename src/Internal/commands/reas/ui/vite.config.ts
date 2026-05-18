import { resolve } from "node:path";
import { DASHBOARDS } from "../../../../utils/ui/dashboards";
import { createDashboardViteConfig } from "../../../../utils/ui/vite.base";

export default createDashboardViteConfig({
    root: __dirname,
    port: DASHBOARDS.reas.port,
    aliases: {
        "@app": resolve(__dirname, "../../../.."),
    },
});
