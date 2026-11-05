import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MobileRoute } from "../../../src/utils/mobile/project";

export const SCHEME = "devdashboard";

/** The expo-router screens of one route group, `_layout` and `+not-found` style files left out. */
function screensIn(dir: string): string[] {
    return readdirSync(dir)
        .filter((file) => file.endsWith(".tsx") && !file.startsWith("_") && !file.startsWith("+"))
        .map((file) => file.replace(/\.tsx$/, ""))
        .sort();
}

/**
 * Every screen of the app, from the expo-router tree, so a new screen file is in the tour, `open` and `capture` without
 * an edit here: the tabs in tab bar order (`devdashboard:///<tab>`), every (more) screen (`devdashboard://<route>`),
 * then the connect gate and the pairing landing. The same links the page objects use.
 */
export function devDashboardRoutes(appDir: string): MobileRoute[] {
    const app = join(appDir, "src", "app");
    const tabs = screensIn(join(app, "(tabs)"));
    // The tab bar order is the trigger order in the layout; a tab file the layout does not name goes last.
    const layout = readFileSync(join(app, "(tabs)", "_layout.tsx"), "utf8");
    const triggers = [...layout.matchAll(/Trigger name="([^"]+)"/g)].map((match) => match[1]);
    const ordered = [...triggers.filter((tab) => tabs.includes(tab)), ...tabs.filter((tab) => !triggers.includes(tab))];
    const tabRoutes = ordered.map((tab) => ({
        name: tab === "index" ? "pulse" : tab,
        url: `${SCHEME}:///${tab === "index" ? "" : tab}`,
        rootId: `screen-${tab === "index" ? "pulse" : tab}`,
    }));
    const moreRoutes = screensIn(join(app, "(more)")).map((route) => ({
        name: route,
        url: `${SCHEME}://${route}`,
        rootId: `screen-${route}`,
    }));

    // The root screens outside the groups: the connect gate, and the pairing landing a QR or link opens. A pairing link
    // never connects by itself (the screen waits for a Pair tap), so the tour can show it safely. Only a tunnel or
    // managed tier makes a valid link.
    const rootRoutes = [
        { name: "connect", url: `${SCHEME}://connect`, rootId: "connect-screen" },
        {
            name: "pair",
            url: `${SCHEME}://pair?tier=cloudflared-self&baseUrl=${encodeURIComponent("https://mac.example.com")}&username=demo`,
            rootId: "pair-screen",
        },
    ];

    return [...tabRoutes, ...moreRoutes, ...rootRoutes];
}
