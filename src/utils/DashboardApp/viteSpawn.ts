import { resolve } from "node:path";
import { PROJECT_ROOT } from "@app/utils/paths";
import type { DashboardBindHost } from "./types";

export const DEFAULT_BIND_HOST: DashboardBindHost = "127.0.0.1";

export function resolveViteEntry(): string {
    return resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");
}

export type DashboardUiServeMode = "preview" | "dev";

export interface ViteDevCmdOptions {
    configPath: string;
    port?: number;
    strictPort?: boolean;
    bindHost?: DashboardBindHost;
    viteEntry?: string;
}

export interface DashboardUiServerCmdOptions {
    /** Tool entry that implements the hidden `__ui-server` command. */
    serverScript: string;
    mode?: DashboardUiServeMode;
    /** Defaults to `bun`. */
    runtime?: string;
}

/**
 * Spawn argv for dashboards that run a Bun front-proxy + internal Vite (dev or preview).
 * Default mode is `preview` (watch build + static preview — better over tunnels).
 */
export function buildDashboardUiServerCmd(opts: DashboardUiServerCmdOptions): string[] {
    const runtime = opts.runtime ?? "bun";
    const mode = opts.mode ?? "preview";
    const cmd = [runtime, opts.serverScript, "__ui-server"];

    if (mode === "dev") {
        cmd.push("--dev");
    }

    return cmd;
}

/** Standard `vite dev` argv for DashboardApp UI tools. */
export function buildViteDevCmd(opts: ViteDevCmdOptions): string[] {
    const entry = opts.viteEntry ?? resolveViteEntry();
    const bindHost = opts.bindHost ?? DEFAULT_BIND_HOST;
    const cmd: string[] = ["bun", "--bun", entry, "dev", "-c", opts.configPath, "--host", bindHost];

    if (opts.port !== undefined) {
        cmd.push("--port", String(opts.port));
    }

    if (opts.strictPort) {
        cmd.push("--strictPort");
    }

    return cmd;
}
