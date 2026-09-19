import { frontmostTarget } from "@app/control/lib/decision/frontmost";
import type { NativeControlDriver } from "@app/control/lib/decision/native";
import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { profiler } from "@genesiscz/utils/profile";
import type { MenuCandidates } from "./menu-candidates";

const prof = profiler.scope("jev-listen");

/** Brave prints "<tab title> - Brave - <profile>"; the tab title is the part CDP knows. */
export function browserTabTitle(windowTitle: string | undefined): string | undefined {
    const cut = (windowTitle ?? "").split(" - ")[0]?.trim();
    return cut !== undefined && cut.length > 2 ? cut : undefined;
}

export interface ListenTarget {
    app: string;
    title?: string;
    source: "flag" | "frontmost";
}

/** One app's driver and menu session; rebuilt whenever the focused app changes. */
export interface BoundTarget {
    app: string;
    driver: NativeControlDriver;
    menus?: MenuCandidates;
}

/**
 * `--app` wins. Otherwise the target is the app the user is looking at: the first on-screen window,
 * front to back, that is not this process's own terminal chain or system UI. The terminal that
 * runs `jev listen` is in front when Enter is pressed, so the pick falls through to the window
 * behind it, which is the one the user was just using.
 */
export async function resolveListenTarget(options: { app?: string }): Promise<ListenTarget | null> {
    if (options.app) {
        return { app: options.app, source: "flag" };
    }

    const front = await prof.measureAsync("frontmost", () => frontmostTarget());
    if (!front) {
        ui.err("No app window is in front of this terminal. Pass --app <name>.");
        ui.info(suggestCommand("tools jev listen", { add: ["--app", "Brave Browser"] }));
        process.exitCode = 1;
        return null;
    }

    return { app: front.app, title: front.title, source: "frontmost" };
}
