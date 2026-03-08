import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { createDashboardViteConfig } from "../../utils/ui/vite.base";

/**
 * Polyfill Bun.file() and Bun.write() for Vite's Node-based SSR context.
 * Vite runs under Node even when launched via bunx, so Bun globals are unavailable.
 */
function ensureBunPolyfill(): void {
    if (typeof globalThis.Bun !== "undefined") {
        return;
    }

    (globalThis as Record<string, unknown>).Bun = {
        file(path: string) {
            return {
                text: () => readFile(path, "utf8"),
                exists: () =>
                    readFile(path)
                        .then(() => true)
                        .catch(() => false),
            };
        },
        async write(path: string, content: string | Buffer) {
            await writeFile(path, content);
        },
    };
}

/**
 * Loads the API handler via ssrLoadModule (handles TS transpilation and @app/* aliases).
 * Bun globals are polyfilled so server-side code using Bun.file()/Bun.write() works.
 */
function lazyApiPlugin(): Plugin {
    return {
        name: "clarity-api-lazy",
        configureServer(server) {
            ensureBunPolyfill();

            server.middlewares.use(async (req, res, next) => {
                if (!req.url?.startsWith("/api/")) {
                    return next();
                }

                try {
                    let body: Record<string, unknown> = {};

                    if (req.method !== "GET") {
                        const chunks: Buffer[] = [];

                        for await (const chunk of req) {
                            chunks.push(chunk as Buffer);
                        }

                        const raw = Buffer.concat(chunks).toString();

                        if (raw) {
                            body = JSON.parse(raw);
                        }
                    }

                    const mod = await server.ssrLoadModule("./src/server/api-handler.ts");
                    await mod.handleApiRequest(req, res, body);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`[clarity-api] ${req.method} ${req.url} failed:`, message);

                    if (err instanceof Error && err.stack) {
                        console.error(err.stack);
                    }

                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: message }));
                }
            });
        },
    };
}

export default createDashboardViteConfig({
    root: __dirname,
    port: 3071,
    plugins: [lazyApiPlugin()],
    aliases: {
        "@app": resolve(__dirname, "../.."),
    },
});
