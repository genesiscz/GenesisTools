import { createServer, type ViteDevServer } from "vite";
import { artifactServePlugin } from "./catalog";
import { baseOptimizeDeps, basePlugins, baseResolve, cacheDirFor, REPO_ROOT } from "./vite";

export interface ServeOptions {
    dir: string;
    port: number;
    host?: string;
    templateDir: string;
}

/**
 * Start a Vite dev server rooted at `dir` with React + Tailwind preconfigured
 * from this repo's dependencies — the served folder needs no node_modules and
 * no config. HTML files are served in place (mpa, no SPA fallback), TSX mounts
 * via /__tsx/, markdown renders via /__md/, and `/` is a catalog page.
 */
export async function serveArtifacts(options: ServeOptions): Promise<ViteDevServer> {
    const server = await createServer({
        configFile: false,
        envFile: false,
        root: options.dir,
        appType: "mpa",
        cacheDir: cacheDirFor(options.dir),
        logLevel: "warn",
        plugins: [...basePlugins(), artifactServePlugin({ dir: options.dir, templateDir: options.templateDir })],
        resolve: baseResolve(),
        optimizeDeps: baseOptimizeDeps(),
        server: {
            port: options.port,
            strictPort: false,
            host: options.host ?? "127.0.0.1",
            fs: { allow: [options.dir, REPO_ROOT] },
        },
    });

    await server.listen();

    return server;
}
