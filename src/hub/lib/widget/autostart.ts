import { existsSync } from "node:fs";
import { readManifest } from "@app/macos/lib/permissions/app";
import { installedParts } from "@app/macos/lib/permissions/parts";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { findProcesses } from "@genesiscz/utils/process/processes";
import { readWidgetState } from "./storage";

const { log } = logger.scoped("widget-autostart");

/** The widget face's command line, as `ps` shows it: `…/MacOS/GenesisTools --widget …`. */
const WIDGET_PROCESS = /\/MacOS\/GenesisTools --widget\b/;

export interface WidgetAutostartDeps {
    platform: NodeJS.Platform;
    showWidget: () => Promise<boolean>;
    bundle: () => string | null;
    /** The installed build links the widget part (a build can leave it out: `--parts`). */
    widgetBuilt: () => boolean;
    widgetRunning: () => boolean;
    launch: (argv: string[]) => unknown;
}

export type WidgetAutostartResult = "started" | "running" | "hidden" | "no-app" | "not-built" | "not-macos";

const defaultDeps: WidgetAutostartDeps = {
    platform: process.platform,
    showWidget: async () => (await readWidgetState()).preferences.showWidget,
    bundle: () => {
        const bundle = genesisAppBundlePath();
        return existsSync(bundle) ? bundle : null;
    },
    widgetBuilt: () => installedParts(readManifest()).includes("widget"),
    widgetRunning: () => findProcesses({ command: WIDGET_PROCESS }).length > 0,
    launch: async (argv) => {
        const code = await Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
        if (code !== 0) {
            throw new Error(`Widget launch failed with exit ${code}`);
        }
    },
};

/**
 * Starts the widget when it should be on screen and is not: nothing started it after a login, so a reboot left it
 * off while its preference said "shown" (2026-11-02, after the macOS 27.2 update). The daemon calls this once at its
 * start, which launchd runs at login. It launches nothing when the app is not installed, when the installed build has no
 * widget part, or when "Show the widget" is off (its default). `--ensure-running` makes a widget that is already up ignore the launch.
 */
export async function ensureWidgetRunning(deps: Partial<WidgetAutostartDeps> = {}): Promise<WidgetAutostartResult> {
    const d = { ...defaultDeps, ...deps };

    if (d.platform !== "darwin") {
        return "not-macos";
    }

    const bundle = d.bundle();

    if (!bundle) {
        return "no-app";
    }

    if (!d.widgetBuilt()) {
        return "not-built";
    }

    if (!(await d.showWidget())) {
        return "hidden";
    }

    if (d.widgetRunning()) {
        return "running";
    }

    await d.launch(["open", "-n", "-g", bundle, "--args", "--widget", "--ensure-running", "--no-activate"]);
    log.info({ bundle }, "widget was not running though shown: started it");

    return "started";
}
