import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { parseConfig, type RouterConfig } from "./route";

export type { RouteAction, RouteRule, RouterConfig, ToastSettings } from "./route";

export function browserRouterStorage(): Storage {
    return new Storage("browser-router");
}

/** `~/.genesis-tools/browser-router/config.json`, the file GenesisTools.app reads on every click. */
export function configFile(): string {
    return browserRouterStorage().getConfigPath();
}

/**
 * The saved config, or null when there is none or it does not parse. Read-only: it never writes,
 * never adds the built-in routes, and never creates the directory. Writers live in the
 * browser-router tool (`src/browser-router/lib/config.ts`).
 */
export function readRouterConfig(path: string = configFile()): RouterConfig | null {
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        logger.debug({ error, path }, "browser-router: no saved config");
        return null;
    }

    try {
        return parseConfig(SafeJSON.parse(text, { strict: true }));
    } catch (error) {
        logger.warn({ error, path }, "browser-router: the saved config does not parse");
        return null;
    }
}
