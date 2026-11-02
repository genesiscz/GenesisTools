import { type ClarityConfig, getConfig, requireConfig, saveConfig } from "@app/clarity/config";
import { savedAuthDriver } from "@app/clarity/lib/auth/drivers";
import { claritySessionStore } from "@app/clarity/lib/auth/session-store";
import type { ClarityAuth, ClarityAuthDriver } from "@app/clarity/lib/auth/types";
import { ClarityApi, type ClarityApiConfig } from "@genesiscz/utils/clarity";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";

async function savedSession(): Promise<ClarityApiConfig> {
    const config = await requireConfig();
    const session = await claritySessionStore.read();

    if (!session) {
        throw new Error(`Clarity is not signed in. Run: ${toolCommand("clarity configure auth")}`);
    }

    return { baseUrl: config.baseUrl, ...session };
}

/**
 * The Clarity API on the saved session, loaded on the first request. A 401 renews it through the saved
 * driver. A session passed in is used as it is and never renewed, so nothing is written for it.
 */
export class ClarityClient extends ClarityApi {
    private readonly given: boolean;

    constructor(auth?: ClarityAuth) {
        super(auth ?? savedSession);
        this.given = auth !== undefined;
    }

    protected override async renewAuth(): Promise<boolean> {
        if (this.given) {
            return false;
        }

        const config = await getConfig();
        const driver = savedAuthDriver(config?.auth?.driver);

        if (!config || !driver?.renew) {
            return false;
        }

        const auth = await driver.renew({ baseUrl: config.baseUrl });
        await saveSession(config, auth);
        this.replaceSession(auth);

        return true;
    }
}

export function isClarityAuthError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    return msg.includes("401") || msg.includes("403") || lower.includes("session") || lower.includes("token");
}

/** The config keeps everything but the session, which goes to the session store. */
async function saveSession(config: ClarityConfig, auth: ClarityAuth): Promise<void> {
    const { authToken: _token, sessionId: _session, cookies: _cookies, ...rest } = config;
    const { baseUrl, ...session } = auth;

    await saveConfig({ ...rest, baseUrl });
    await claritySessionStore.write(session);
}

export interface SavedSignIn {
    config: ClarityConfig;
    resource?: { id: number; full_name: string; email: string };
}

/** Check a fresh sign-in against the server, then save it with the existing mappings. The only writer of a session. */
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
        baseUrl: auth.baseUrl,
        resourceId: resource?.id ?? existing?.resourceId,
        uniqueName: resource?.email ?? existing?.uniqueName,
        mappings: existing?.mappings ?? [],
        auth: { driver: driver.id },
    };

    await saveSession(config, auth);

    return { config, resource };
}
