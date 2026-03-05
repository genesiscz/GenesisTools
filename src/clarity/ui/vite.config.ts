import { createDashboardViteConfig } from "../../utils/ui/vite.base";
import { apiPlugin } from "./src/server/api-plugin";

export default createDashboardViteConfig({
    root: __dirname,
    port: 3071,
    plugins: [apiPlugin()],
});
