import { getConfig, saveConfig, storage } from "@app/clarity/config";
import type { ClaritySessionStore } from "@app/clarity/lib/auth/types";

/** The scheme, host and port of a base URL, or null for one that does not parse. */
export function clarityOrigin(baseUrl: string): string | null {
    try {
        return new URL(baseUrl).origin;
    } catch {
        return null;
    }
}

/** The session inside the config file (mode 0600), beside the mappings and the base URL it belongs to. */
export const fileSessionStore: ClaritySessionStore = {
    describe: () => `${storage.getConfigPath()} (mode 0600)`,
    async read(baseUrl) {
        const config = await getConfig();
        const origin = clarityOrigin(baseUrl);

        // The config names the server its session belongs to: another server never gets it.
        return config?.authToken && config.sessionId && origin !== null && clarityOrigin(config.baseUrl) === origin
            ? { authToken: config.authToken, sessionId: config.sessionId, cookies: config.cookies }
            : null;
    },
    async write(session) {
        const config = await getConfig();

        if (!config) {
            throw new Error("Save the Clarity config before its session.");
        }

        await saveConfig({ ...config, ...session });
    },
    async clear() {
        const config = await getConfig();

        if (config) {
            const { authToken: _token, sessionId: _session, cookies: _cookies, ...rest } = config;
            await saveConfig(rest);
        }
    },
};
