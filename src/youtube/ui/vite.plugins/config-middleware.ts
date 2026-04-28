import { SafeJSON } from "@app/utils/json";
import { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import type { Plugin } from "vite";

export function youtubeConfigPlugin(): Plugin {
    return {
        name: "youtube-config-middleware",
        configureServer(server) {
            server.middlewares.use("/__config", async (req, res, next) => {
                if (!req.url || (req.method !== "GET" && req.method !== "PATCH")) {
                    return next();
                }

                const config = new YoutubeConfig();

                if (req.method === "GET") {
                    const current = await config.getAll();
                    res.setHeader("Content-Type", "application/json");
                    res.end(SafeJSON.stringify({ config: current, where: config.where() }));
                    return;
                }

                let body = "";
                req.on("data", (chunk: Buffer | string) => {
                    body += chunk.toString();
                });
                req.on("end", async () => {
                    try {
                        const patch = SafeJSON.parse(body || "{}") as YoutubeConfigPatch;
                        await config.update(patch);
                        const current = await config.getAll();
                        res.setHeader("Content-Type", "application/json");
                        res.end(SafeJSON.stringify({ config: current }));
                    } catch (err) {
                        res.statusCode = 400;
                        res.setHeader("Content-Type", "application/json");
                        res.end(SafeJSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
                    }
                });
            });
        },
    };
}
