import { type ClarityConfig, getConfig, saveConfig } from "@app/clarity/config";
import { savedAuthDriver } from "@app/clarity/lib/auth/drivers";
import type { ClarityAuth, ClarityAuthDriver } from "@app/clarity/lib/auth/types";
import { ClarityApi } from "@genesiscz/utils/clarity";

/** The Clarity API for a saved config. A 401 signs in again through the saved driver, when it can do so unasked. */
export class ClarityClient extends ClarityApi {
    constructor(private saved: Pick<ClarityConfig, "baseUrl" | "authToken" | "sessionId" | "cookies" | "auth">) {
        super({
            baseUrl: saved.baseUrl,
            authToken: saved.authToken,
            sessionId: saved.sessionId,
            cookies: saved.cookies,
        });
    }

    protected override async renewAuth(): Promise<boolean> {
        const driver = savedAuthDriver(this.saved.auth?.driver);

        if (!driver?.renew) {
            return false;
        }

        const auth = await driver.renew({ baseUrl: this.saved.baseUrl });
        const latest = await getConfig();

        if (latest) {
            await saveConfig({ ...latest, ...auth });
        }

        this.saved = { ...this.saved, ...auth };
        this.config = auth;

        return true;
    }
}

export function isClarityAuthError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    return msg.includes("401") || msg.includes("403") || lower.includes("session") || lower.includes("token");
}

export interface SavedSignIn {
    config: ClarityConfig;
    resource?: { id: number; full_name: string; email: string };
}

/** Check a fresh sign-in against the server, then save it with the existing mappings. */
export async function saveSignIn({
    auth,
    driver,
    existing,
}: {
    auth: ClarityAuth;
    driver: ClarityAuthDriver;
    existing: ClarityConfig | null;
}): Promise<SavedSignIn> {
    // 0 fetches the default/current timesheet app list, not tied to a specific period
    const appData = await new ClarityApi(auth).getTimesheetApp(0);
    const resource = appData.resource._results[0];
    const config: ClarityConfig = {
        ...existing,
        ...auth,
        resourceId: resource?.id ?? existing?.resourceId,
        uniqueName: resource?.email ?? existing?.uniqueName,
        mappings: existing?.mappings ?? [],
        auth: { driver: driver.id },
    };

    await saveConfig(config);

    return { config, resource };
}
