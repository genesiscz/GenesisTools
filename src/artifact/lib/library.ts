import { existsSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { artifactServePlugin, cachedScan } from "./catalog";
import { createMountCache } from "./mount-cache";
import { GALLERY_DIR, GALLERY_MOUNT } from "./paths";
import { type DashboardEntry, loadRegistry } from "./registry";
import { encodeHrefPath, escapeHtml, loadTemplate, loadThemeCss, renderTemplate } from "./templates";
import { baseOptimizeDeps, basePlugins, baseResolve, cacheDirFor, fsAllowRoots } from "./vite";

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
    /** Folder that holds each mount's Vite cache. Default: the repo's node_modules (`cacheDirFor`). */
    cacheRoot?: string;
}

export interface LibraryHandle {
    port: number;
    close: () => Promise<void>;
}

function ageLabel(iso: string): string {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

    if (days < 1) {
        return "today";
    }

    return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Shipped folders the library always shows, even with an empty registry. A registered folder of the same name wins. */
export const BUILTIN_ENTRIES: DashboardEntry[] = [
    { name: GALLERY_MOUNT, dir: GALLERY_DIR, createdAt: "2026-10-15T00:00:00.000Z", entry: "index.tsx" },
];

/** The registered folder named `name`, else the built-in one. */
export function findLibraryEntry(registry: DashboardEntry[], name: string): DashboardEntry | undefined {
    return registry.find((e) => e.name === name) ?? BUILTIN_ENTRIES.find((e) => e.name === name);
}

function renderLibraryHtml(entries: DashboardEntry[], templateDir: string): string {
    const now = Date.now();
    const listRow = (e: DashboardEntry, builtin: boolean): string => {
        const listing = cachedScan(e.dir, now);
        const counts = [
            listing.tsx.length ? `${listing.tsx.length} tsx` : "",
            listing.html.length ? `${listing.html.length} html` : "",
            listing.md.length ? `${listing.md.length} md` : "",
        ]
            .filter(Boolean)
            .join(" · ");
        const meta = [counts || "empty", builtin ? "built in" : ageLabel(e.createdAt), e.entry ?? ""]
            .filter(Boolean)
            .join(" · ");

        return (
            `<li><a href="${escapeHtml(`/a/${encodeURIComponent(e.name)}/${e.entry ? encodeHrefPath(e.entry.replace(/\.(tsx|jsx|html|md)$/, "")) : ""}`)}">` +
            `<span class="name">${escapeHtml(e.name)}<br><small style="color:var(--dim)">${escapeHtml(e.dir)}</small></span>` +
            `<span class="kind">${escapeHtml(meta)}</span></a></li>`
        );
    };
    const builtins = BUILTIN_ENTRIES.filter((b) => existsSync(b.dir) && !entries.some((e) => e.name === b.name))
        .map((b) => listRow(b, true))
        .join("\n");
    const rows = entries
        .filter((e) => existsSync(e.dir))
        .map((e) => listRow(e, false))
        .join("\n");

    const registered = `<section><h2>Registered artifacts</h2>\n<ul>${
        rows || `<li class="empty">nothing registered — ${toolCommand("artifact add")} &lt;dir&gt;</li>`
    }</ul></section>`;
    const builtIn = builtins ? `\n<section><h2>Built in</h2>\n<ul>${builtins}</ul></section>` : "";
    const sections = `${registered}${builtIn}`;

    return renderTemplate(loadTemplate(templateDir, "catalog.html"), {
        TITLE: "Artifact Library",
        DIR: "every registered folder, one server",
        SECTIONS: sections,
        THEME: loadThemeCss(templateDir),
    });
}

/** Start ONE artifact folder's Vite middleware server, mounted at `/a/<name>/`. */
function startMount(
    entry: DashboardEntry,
    httpServer: ReturnType<typeof createHttpServer>,
    options: LibraryOptions
): Promise<ViteDevServer> {
    logger.info({ name: entry.name, dir: entry.dir }, "[artifact] library: starting mount");
    const urlBase = `/a/${encodeURIComponent(entry.name)}`;

    return createViteServer({
        configFile: false,
        envDir: false,
        root: entry.dir,
        appType: "mpa",
        base: `${urlBase}/`,
        cacheDir: cacheDirFor(entry.dir, options.cacheRoot),
        logLevel: "warn",
        plugins: [...basePlugins(), artifactServePlugin({ dir: entry.dir, templateDir: options.templateDir, urlBase })],
        resolve: baseResolve(),
        optimizeDeps: baseOptimizeDeps(),
        server: {
            middlewareMode: true,
            hmr: { server: httpServer, path: `${urlBase}/__hmr` },
            fs: { allow: fsAllowRoots(entry.dir) },
        },
    });
}

export async function startLibrary(options: LibraryOptions): Promise<LibraryHandle> {
    // The mount factory needs the http server for HMR, and the http server needs
    // the mounts to serve a request; `start` only runs from inside a request.
    let httpServer: ReturnType<typeof createHttpServer> | null = null;
    // Handing the resolved entry to the cache's start callback. Written just
    // before the get() that consumes it and dropped straight after, so nothing
    // survives the request that put it there.
    const pendingEntries = new Map<string, DashboardEntry>();

    const mounts = createMountCache<ViteDevServer>({
        start: (key: string): Promise<ViteDevServer> => {
            const entry = pendingEntries.get(key);

            if (!entry || !httpServer) {
                return Promise.reject(new Error(`No registered artifact folder named "${key.split("\u0000")[0]}".`));
            }

            return startMount(entry, httpServer, options);
        },
        close: (server: ViteDevServer) => server.close(),
    });

    httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
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
                const entry = findLibraryEntry(loadRegistry(), name);

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

                // The mount key carries the directory, not just the name: a folder
                // re-registered under the same name but a NEW path must get a new
                // Vite server, not the one already rooted at the old path.
                const key = `${entry.name}\u0000${entry.dir}`;
                pendingEntries.set(key, entry);
                let sub: ViteDevServer;

                try {
                    sub = await mounts.get(key);
                } finally {
                    pendingEntries.delete(key);
                }

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

    const listening = httpServer;
    await new Promise<void>((resolveListen, reject) => {
        listening.once("error", reject);
        listening.listen(options.port, options.host, () => resolveListen());
    });

    const address = listening.address();

    return {
        // The ASSIGNED port, not the requested one: `--port 0` means "any free
        // port", and callers print this and record it for `tools artifact stop`.
        port: typeof address === "object" && address ? (address as AddressInfo).port : options.port,
        close: async () => {
            await mounts.closeAll();
            await new Promise<void>((r) => listening.close(() => r()));
        },
    };
}
