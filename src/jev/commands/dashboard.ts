import { join, resolve } from "node:path";
import { Browser } from "@genesiscz/utils/browser";
import { logger, out } from "@genesiscz/utils/logger";
import { DASHBOARDS } from "@genesiscz/utils/ui/dashboards";
import type { Command } from "commander";

export async function startDashboard({
    port = DASHBOARDS.jev.port,
    open = true,
}: {
    port?: number;
    open?: boolean;
} = {}) {
    // Loaded here, not at module scope. `src/jev/index.ts` registers every subcommand eagerly,
    // so anything this file imports at the top is paid by `jev wake`, `jev route` and every other
    // call in the live voice loop, none of which serve anything. Measured on this machine:
    // `lib/server/api.ts` 321 ms, `artifact/lib/serve.ts` 134-205 ms over three runs each.
    // Deferring serve.ts alone changed nothing, because api.ts was the larger of the two.
    const [{ serveArtifacts }, { resolveTemplateDir }, { jevApiPlugin }] = await Promise.all([
        import("@app/artifact/lib/serve"),
        import("@app/artifact/lib/templates"),
        import("../lib/server/api"),
    ]);
    const root = resolve(import.meta.dir, "../../..");
    const server = await serveArtifacts({
        dir: join(root, "src/jev/dashboard"),
        port,
        host: "127.0.0.1",
        templateDir: resolveTemplateDir("graphite"),
        plugins: [
            { name: "jev:shared-ui", config: () => ({ resolve: { alias: { "@ui": join(root, "src/utils/ui") } } }) },
            jevApiPlugin(),
        ],
    });
    const base = server.resolvedUrls?.local[0];
    if (!base) {
        await server.close();
        throw new Error("Artifact server did not expose a local URL.");
    }

    const url = `${base}index`;
    out.log.success(`Jev lab: ${url}`);
    if (open) {
        const result = await Browser.open(url);
        if (!result.success) {
            logger.warn({ error: result.error }, "Could not open Jev lab in browser");
        }
    }

    return { server, url };
}

export function registerDashboard(program: Command): void {
    program
        .command("dashboard")
        .alias("ui")
        .description("Open the local Jev artifact workbench")
        .option("--port <port>", "Local port (auto-bumps if busy)", String(DASHBOARDS.jev.port))
        .option("--no-open", "Start without opening a browser")
        .action(async (options: { port: string; open: boolean }) => {
            const port = Number(options.port);
            if (!Number.isInteger(port) || port < 0 || port > 65535) {
                throw new Error("--port must be an integer from 0 to 65535.");
            }

            const { server } = await startDashboard({ port, open: options.open });
            let stopping = false;
            const stop = async () => {
                if (stopping) {
                    return;
                }
                stopping = true;
                const deadline = setTimeout(() => {
                    logger.warn("Jev dashboard cleanup exceeded three seconds; closing the process.");
                    process.exit(0);
                }, 3000);
                deadline.unref();
                try {
                    await server.close();
                } catch (error) {
                    logger.warn({ error }, "Jev dashboard cleanup failed");
                } finally {
                    clearTimeout(deadline);
                    process.exit(0);
                }
            };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
        });
}
