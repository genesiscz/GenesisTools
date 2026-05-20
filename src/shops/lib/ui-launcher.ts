import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "@app/utils/paths";
import { spawnDashboard } from "@app/utils/process/spawnDashboard";

export interface UiLauncherPaths {
    uiDir: string;
    configPath: string;
    viteEntry: string;
}

export interface UiLaunchOptions {
    /** URL the dashboard listens on; opened in a browser ~2s after vite starts. */
    url?: string;
    /** Override paths for testing. */
    paths?: Partial<UiLauncherPaths>;
}

const DEFAULT_URL = "http://localhost:3073";

export function resolveUiPaths(uiDirOverride?: string): UiLauncherPaths {
    const uiDir = uiDirOverride ?? resolve(import.meta.dirname, "..", "ui");
    return {
        uiDir,
        configPath: resolve(uiDir, "vite.config.ts"),
        viteEntry: resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js"),
    };
}

/**
 * Launch the Shops dashboard via vite, open the browser, wait for vite to exit.
 * Returns the vite process exit code (0 on clean exit). Throws if prerequisites
 * (vite binary, vite config) are missing.
 */
export async function launchShopsDashboard(opts: UiLaunchOptions = {}): Promise<number> {
    const paths = { ...resolveUiPaths(), ...opts.paths };
    const url = opts.url ?? DEFAULT_URL;

    if (!existsSync(paths.viteEntry)) {
        throw new Error(`Could not find vite at ${paths.viteEntry}. Run "bun install" in ${PROJECT_ROOT} first.`);
    }

    if (!existsSync(paths.configPath)) {
        throw new Error(`Vite config missing: ${paths.configPath}`);
    }

    process.stdout.write(`Starting Shops dashboard at ${url} ...\n`);
    process.stdout.write("(first start can take a few seconds; output below comes from Vite)\n\n");

    const openTimer = setTimeout(() => {
        openBrowser(url);
    }, 2000);

    try {
        return await spawnDashboard({
            cmd: ["bun", "--bun", paths.viteEntry, "dev", "-c", paths.configPath, "--strictPort"],
            cwd: PROJECT_ROOT,
            env: { SHOPS_PROJECT_CWD: process.cwd() },
        });
    } finally {
        clearTimeout(openTimer);
    }
}

function openBrowser(url: string): void {
    if (process.platform === "darwin") {
        Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
        return;
    }

    if (process.platform === "win32") {
        Bun.spawn(["cmd", "/c", "start", "", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
        return;
    }

    Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
}
