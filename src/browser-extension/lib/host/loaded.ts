import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extensionProfiles } from "@genesiscz/utils/browser-extension/profiles";
import { BROWSER_EXTENSIONS, type BrowserExtensionEntry } from "@genesiscz/utils/browser-extension/registry";
import { suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isRecord } from "../values";
import { hostStatus } from "./install";

function builtHostPermissions(distDir: string): string[] {
    const file = join(distDir, "manifest.json");

    if (!existsSync(file)) {
        return [];
    }

    let manifest: unknown;

    try {
        manifest = SafeJSON.parse(readFileSync(file, "utf8"), { strict: true });
    } catch (error) {
        // A damaged build must not break status and install; they report it as having no hosts.
        logger.warn({ error, file }, "browser-extension: the built manifest is unreadable");
        return [];
    }

    const hosts = isRecord(manifest) ? manifest.host_permissions : undefined;
    return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === "string") : [];
}

/** `tools <args...>` as a runnable suggestion. */
function toolsCommand(args: string[]): string {
    const [tool, ...rest] = args;
    return suggestCommand(`tools ${tool}`, { replaceCommand: rest });
}

function adviceFor(entry: BrowserExtensionEntry): string[] {
    const manifest = join(entry.distDir, "manifest.json");
    const build = `  build:  ${toolsCommand(entry.buildArgs)}`;
    const load = `  load:   brave://extensions (or chrome://extensions) > Developer mode > Load unpacked > ${entry.distDir}`;

    if (!existsSync(manifest)) {
        return [`${entry.name} extension: not built (${entry.purpose})`, build, load];
    }

    const loaded = extensionProfiles({
        extensionId: entry.id,
        wanted: builtHostPermissions(entry.distDir),
        builtAt: statSync(manifest).mtimeMs,
    }).filter((profile) => profile.loaded);

    if (loaded.length === 0) {
        return [`${entry.name} extension: not loaded in any browser (${entry.purpose})`, load];
    }

    const lines = loaded.map((profile) =>
        profile.stale
            ? `${entry.name} extension: OLDER BUILD in ${profile.browser} (${profile.profile}). Reload: ${toolsCommand(entry.reloadArgs)}`
            : `${entry.name} extension: loaded in ${profile.browser} (${profile.profile})`
    );

    if (entry.status === "native-host") {
        const hosts = hostStatus();
        const unreachable = hosts.browsers.some((browser) =>
            loaded.some((profile) => profile.browser === browser.browser && !browser.allowsThisId)
        );

        if (!hosts.launcherExists || unreachable) {
            lines.push(
                `${entry.name} extension: its native host is not registered, so it cannot ask the router. Run: ${toolsCommand(["browser-extension", "install-host"])}`
            );
        }
    }

    return lines;
}

/**
 * What `tools browser-router status` and `install` print about the GenesisTools extensions: not
 * built, not loaded, an older build than `dist` (a Reload is due), or a native host out of reach.
 */
export function extensionAdvice(): string[] {
    return BROWSER_EXTENSIONS.flatMap(adviceFor);
}
