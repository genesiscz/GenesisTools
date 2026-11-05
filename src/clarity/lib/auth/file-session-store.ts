import { getConfig, saveConfig, storage } from "@app/clarity/config";
import type { ClaritySessionStore } from "@app/clarity/lib/auth/types";

/** The session inside the config file (mode 0600), beside the mappings. */
export const fileSessionStore: ClaritySessionStore = {
    describe: () => `${storage.getConfigPath()} (mode 0600)`,
    async read() {
        const config = await getConfig();

        return config?.authToken && config.sessionId
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
