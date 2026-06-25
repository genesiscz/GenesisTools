import { env } from "@app/utils/env";
import { ensureDashboardBuilt } from "../commands/dashboard";
import { startServer } from "../core/http-server";

const port = Number.parseInt(String(env.log.getDashboardPort()), 10);

await ensureDashboardBuilt();
startServer(port);
await new Promise(() => {});
