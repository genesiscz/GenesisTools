import { resolve } from "node:path";
// Relative on purpose: config bundlers inline relative imports but externalize bare ones.
import { env } from "../../utils/env.client";
import { DASHBOARDS } from "../../utils/ui/dashboards";
import { createDashboardViteConfig } from "../../utils/ui/vite.base";

// `Number` rather than `parseInt`: the latter takes a numeric prefix, so "3075junk" would pass
// as 3075 instead of falling back to the registry port.
const configuredPort = Number(env.spotify.getUiPort() ?? "");
const usable = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535;
const port = usable ? configuredPort : DASHBOARDS.spotify.port;

export default createDashboardViteConfig({
    root: __dirname,
    port,
    // Loopback only. This dashboard serves one person's entire listening history and the
    // filesystem paths it is read from, with no authentication: on every interface, anything
    // that can reach the port can read all of it, and the same-origin guard on the write route
    // is CSRF protection, not a check of who is calling.
    host: DASHBOARDS.spotify.bindHost ?? "127.0.0.1",
    aliases: {
        "@app": resolve(__dirname, "../.."),
    },
    watchDirs: ["spotify"],
    tanstackStartOptions: {
        srcDirectory: ".",
    },
});
