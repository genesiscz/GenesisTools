import { existsSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { logger } from "@genesiscz/utils/logger";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { artifactServePlugin, scanArtifacts } from "./catalog";
import { type DashboardEntry, loadRegistry } from "./registry";
import { loadTemplate, loadThemeCss, renderTemplate } from "./templates";
import { baseOptimizeDeps, basePlugins, baseResolve, cacheDirFor, REPO_ROOT } from "./vite";

/**
 * `tools artifact library up`: ONE server for every registered artifact folder.
 * `/` is the library page (name, dir, artifact counts, age, click to open);
 * each folder mounts at `/a/<name>/` through its own lazily-started Vite
 * middleware (created on first hit, so startup stays instant regardless of how
 * many folders are registered). Clean URLs work under every mount.
 */

export interface LibraryOptions {
    port: number;
    host: string;
    templateDir: string;
}

export interface LibraryHandle {
    port: number;
    close: () => Promise<void>;
}

function escapeHtml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function ageLabel(iso: string): string {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

    if (days < 1) {
        return "today";
    }

    return days === 1 ? "1 day ago" : `${days} days ago`;
}

function renderLibraryHtml(entries: DashboardEntry[], templateDir: string): string {
    const rows = entries
        .filter((e) => existsSync(e.dir))
        .map((e) => {
            const listing = scanArtifacts(e.dir);
            const counts = [
                listing.tsx.length ? `${listing.tsx.length} tsx` : "",
                listing.html.length ? `${listing.html.length} html` : "",
                listing.md.length ? `${listing.md.length} md` : "",
            ]
                .filter(Boolean)
                .join(" · ");
            const meta = [counts || "empty", ageLabel(e.createdAt), e.entry ?? ""].filter(Boolean).join(" · ");

            return (
                `<li><a href="/a/${encodeURIComponent(e.name)}/${e.entry ? e.entry.replace(/\.(tsx|jsx|html|md)$/, "") : ""}">` +
                `<span class="name">${escapeHtml(e.name)}<br><small style="color:var(--dim)">${escapeHtml(e.dir)}</small></span>` +
                `<span class="kind">${escapeHtml(meta)}</span></a></li>`
            );
        })
        .join("\n");

    const sections = `<section><h2>Registered artifacts</h2>\n<ul>${
        rows || `<li class="empty">nothing registered — tools artifact add &lt;dir&gt;</li>`
    }</ul></section>`;

    return renderTemplate(loadTemplate(templateDir, "catalog.html"), {
        TITLE: "Artifact Library",
        DIR: "every registered folder, one server",
        SECTIONS: sections,
        THEME: loadThemeCss(templateDir),
    });
}

export async function startLibrary(options: LibraryOptions): Promise<LibraryHandle> {
    const subServers = new Map<string, Promise<ViteDevServer>>();

    const subFor = (entry: DashboardEntry, httpServer: ReturnType<typeof createHttpServer>): Promise<ViteDevServer> => {
        const existing = subServers.get(entry.name);

        if (existing) {
            return existing;
        }

        logger.info({ name: entry.name, dir: entry.dir }, "[artifact] library: starting mount");
        const urlBase = `/a/${entry.name}`;
        const created = createViteServer({
            configFile: false,
            envFile: false,
            root: entry.dir,
            appType: "mpa",
            base: `${urlBase}/`,
            cacheDir: cacheDirFor(entry.dir),
            logLevel: "warn",
            plugins: [
                ...basePlugins(),
                artifactServePlugin({ dir: entry.dir, templateDir: options.templateDir, urlBase }),
            ],
            resolve: baseResolve(),
            optimizeDeps: baseOptimizeDeps(),
            server: {
                middlewareMode: true,
                hmr: { server: httpServer, path: `${urlBase}/__hmr` },
                fs: { allow: [entry.dir, REPO_ROOT] },
            },
        });
        subServers.set(entry.name, created);

        return created;
    };

    const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
        const handle = async (): Promise<void> => {
            const urlPath = (req.url ?? "/").split("?")[0];

            if (urlPath === "/" || urlPath === "/index.html") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(renderLibraryHtml(loadRegistry(), options.templateDir));

                return;
            }

            const mount = urlPath.match(/^\/a\/([^/]+)(\/.*)?$/);

            if (mount) {
                const name = decodeURIComponent(mount[1]);
                const entry = loadRegistry().find((e) => e.name === name);

                if (!entry || !existsSync(entry.dir) || !statSync(entry.dir).isDirectory()) {
                    res.statusCode = 404;
                    res.end(`No registered artifact folder named "${name}".`);

                    return;
                }

                if (!mount[2]) {
                    res.statusCode = 302;
                    res.setHeader("Location", `/a/${encodeURIComponent(name)}/`);
                    res.end();

                    return;
                }

                const sub = await subFor(entry, httpServer);
                sub.middlewares(req, res, () => {
                    res.statusCode = 404;
                    res.end("Not found");
                });

                return;
            }

            res.statusCode = 302;
            res.setHeader("Location", "/");
            res.end();
        };

        handle().catch((err: unknown) => {
            logger.warn({ err, url: req.url }, "[artifact] library request failed");
            res.statusCode = 500;
            res.end("library error");
        });
    });

    await new Promise<void>((resolveListen, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(options.port, options.host, () => resolveListen());
    });

    return {
        port: options.port,
        close: async () => {
            for (const pending of subServers.values()) {
                await (await pending).close();
            }

            await new Promise<void>((r) => httpServer.close(() => r()));
        },
    };
}
