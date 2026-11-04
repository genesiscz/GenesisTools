import type { MobileApp } from "@app/mobile/lib/types";
import { devDashboardApp } from "./dev-dashboard/adapter";

export const MOBILE_APPS: Record<string, MobileApp> = {
    [devDashboardApp.id]: devDashboardApp,
};

export function mobileApp(id: string): MobileApp {
    const app = MOBILE_APPS[id];

    if (!app) {
        throw new Error(`unknown app "${id}"; known: ${Object.keys(MOBILE_APPS).join(", ")}`);
    }

    return app;
}
