import { type ClarityConfig, getConfig, requireConfig, saveConfig } from "@app/clarity/config";
import { savedAuthDriver } from "@app/clarity/lib/auth/drivers";
import { claritySessionStore } from "@app/clarity/lib/auth/session-store";
import type { ClarityAuth, ClarityAuthDriver } from "@app/clarity/lib/auth/types";
import { ClarityApi, type ClarityApiConfig } from "@genesiscz/utils/clarity";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";

async function savedSession(): Promise<ClarityApiConfig> {
    const config = await requireConfig();
    const session = await claritySessionStore.read(config.baseUrl);

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
    /**
     * False for a session passed in and for a diagnostic: an expired session fails as it is, and no driver signs in
     * again or writes a session.
     */
    private readonly renews: boolean;

    constructor(auth?: ClarityAuth, { renews = true }: { renews?: boolean } = {}) {
        super(auth ?? savedSession);
        this.renews = renews && auth === undefined;
    }

    /** The saved session for a status check or a preflight, which must never renew it (they only read). */
    static withoutRenew(): ClarityClient {
        return new ClarityClient(undefined, { renews: false });
    }

    protected override async renewAuth(): Promise<boolean> {
        if (!this.renews) {
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

/**
 * The config keeps everything but the session, which goes to the session store. The session is written first: a stop
 * between the two writes leaves the new session saved and the old config, never a config whose session was dropped
 * before its replacement was saved. The config write drops a session still kept in it (the move to the store).
 */
async function saveSession(config: ClarityConfig, auth: ClarityAuth): Promise<void> {
    const { authToken: _token, sessionId: _session, cookies: _cookies, ...rest } = config;
    const { baseUrl, ...session } = auth;

    await claritySessionStore.write(session, baseUrl);
    await saveConfig({ ...rest, baseUrl });
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
