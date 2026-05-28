import { ensureDashboardBuilt } from "../commands/dashboard";
import { startServer } from "../core/http-server";

const port = Number.parseInt(process.env.LOG_DASHBOARD_PORT ?? "7243", 10);

await ensureDashboardBuilt();
startServer(port);
await new Promise(() => {});
